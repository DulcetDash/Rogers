const async = require('async');
const axios = require('axios');
const {
    presignS3URL,
    extractS3ImagePath,
    generateCloudfrontSignedUrl,
} = require('./PresignDocs');
const ESClient = require('./ES');
const Redis = require('./Redis');
const CatalogueModel = require('./models/CatalogueModel');
const StoreModel = require('./models/StoreModel');

exports.deleteKeysWithSuffix = async (redis, suffix) => {
    let cursor = '0';
    do {
        // Scan with each iteration (starting with cursor '0')
        const reply = await redis.scan(
            cursor,
            'MATCH',
            `*${suffix}`,
            'COUNT',
            100
        );
        cursor = reply[0]; // Update the cursor position for the next scan
        const keys = reply[1];

        // If keys are found, delete them
        if (keys.length > 0) {
            await redis.del(keys);
        }
    } while (cursor !== '0'); // When the cursor returns to '0', we've scanned all keys

    redis.disconnect();
    console.log('All keys with specified suffix deleted.');
};

exports.batchPresignProductsLinks = async (
    productsData,
    shouldDoubleCheckImage = false
) => {
    //Create presigned product links for the ones we host (s3://)
    productsData = await Promise.all(
        productsData.map(async (product) => {
            if (product.product_picture?.[0].includes('s3://')) {
                const s3URIImage = product.product_picture[0];
                const cachedPresignedImage = await Redis.get(s3URIImage);

                if (!cachedPresignedImage) {
                    const presignedURL = await generateCloudfrontSignedUrl(
                        `${
                            process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_LINK
                        }/${extractS3ImagePath(s3URIImage)}`
                    );

                    product.product_picture = [presignedURL];

                    //Cache the presigned URL - Has to be less than presign time
                    await Redis.set(
                        s3URIImage,
                        presignedURL,
                        'EX',
                        1 * 24 * 3600
                    );

                    return product;
                }

                product.product_picture = [cachedPresignedImage];
                return product;
            }
            return product;
        })
    );

    return productsData;
};

exports.getAllItemsByShopFp = async (index, shopFpValue) => {
    const results = [];
    try {
        // Initial search request
        const initialResponse = await ESClient.search({
            index: index,
            scroll: '1m', // Keep the search context alive for 1 minute
            size: 1000,
            body: {
                query: {
                    match: {
                        shop_fp: shopFpValue,
                    },
                },
            },
        });

        // Push initial batch of results
        initialResponse.hits.hits.forEach((hit) => results.push(hit._source));

        let scrollId = initialResponse._scroll_id;
        while (initialResponse.hits.hits.length) {
            const scrollResponse = await ESClient.scroll({
                scroll_id: scrollId,
                scroll: '1m',
            });

            // Push next batch of results
            scrollResponse.hits.hits.forEach((hit) =>
                results.push(hit._source)
            );

            // Update the scroll ID for the next scroll request
            scrollId = scrollResponse._scroll_id;

            // Exit condition if no more results are returned
            if (scrollResponse.hits.hits.length === 0) {
                break;
            }
        }

        // Clear the scroll context when done
        await ESClient.clearScroll({
            scroll_id: [scrollId],
        });
    } catch (error) {
        console.error('An error occurred while fetching items:', error);
        throw error;
    }

    return results;
};

exports.batchPresignProductsOptionsImageLinks = async (productsOptions) => {
    if (!Array.isArray(productsOptions) || !productsOptions)
        return productsOptions;

    if (!productsOptions[0]?.image) return productsOptions;

    //Create presigned product links for the ones we host (s3://)
    productsOptions = await Promise.all(
        productsOptions.map(async (product) => {
            if (product.image?.[0].includes('s3://')) {
                const s3URIImage = product.image[0];
                const cachedPresignedImage = await Redis.get(s3URIImage);

                if (!cachedPresignedImage) {
                    const presignedURL = await generateCloudfrontSignedUrl(
                        `${
                            process.env.DD_PRODUCTS_IMAGES_CLOUDFRONT_LINK
                        }/${extractS3ImagePath(s3URIImage)}`
                    );

                    product.image = [presignedURL];
                    //Cache the presigned URL - Has to be less than presign time
                    await Redis.set(
                        s3URIImage,
                        presignedURL,
                        'EX',
                        1 * 24 * 3600
                    );
                } else {
                    product.image = [cachedPresignedImage];
                }
            }
            return product;
        })
    );

    return productsOptions;
};

/**
 * @func getCatalogueFor
 * Get all the products for a specific store
 * @param req: store infos
 * @param resolve
 */
exports.getCatalogueFor = async (body) => {
    const {
        store: storeFp,
        category,
        subcategory,
        structured,
        getAllItems,
        customPageSize,
    } = body;
    const shouldGetAllItems = !!getAllItems;

    const shop = await StoreModel.get(storeFp);

    if (!shop) return { response: {}, store: null };

    const storeData = shop;

    //? Increment store's reputation points
    const storeReputationPoint = (shop?.reputation ?? 0) + 1;

    await StoreModel.update(
        {
            id: shop.id,
        },
        {
            reputation: storeReputationPoint,
        }
    );

    const pageNumber = body?.pageNumber ? parseInt(body?.pageNumber, 10) : 1;
    const pageSize = customPageSize ?? 200;

    const paginationStart = (pageNumber - 1) * pageSize;
    const paginationEnd = pageNumber * pageSize;

    const redisKey = `${storeFp}-catalogue`;

    let cachedData = await Redis.get(redisKey);

    if (cachedData) {
        cachedData = JSON.parse(cachedData);
    } else {
        cachedData = [];
    }

    let productsData =
        cachedData.length > 0
            ? cachedData
            : await exports.getAllItemsByShopFp(
                  process.env.CATALOGUE_INDEX,
                  body.store
              );

    if (cachedData.length <= 0) {
        Redis.set(redisKey, JSON.stringify(productsData), 'EX', 3600 * 24 * 2);
    }

    if (productsData?.count > 0 || productsData?.length > 0) {
        //?Limit all the results to 200 products
        productsData = productsData.slice(paginationStart, paginationEnd);

        //Create presigned product links for the ones we host (s3://)
        productsData = await exports.batchPresignProductsLinks(productsData);

        //Reformat the data
        const reformattedData = await Promise.all(
            productsData.map(async (product, index) => {
                const tmpData = {
                    id: product.id,
                    index: index,
                    name: product.product_name,
                    price: String(product.priceAdjusted),
                    currency: product.currency,
                    pictures: product.product_picture,
                    sku: product.sku,
                    meta: {
                        category: product.category,
                        subcategory: product.subcategory,
                        store: product.shop_name,
                        store_fp: storeFp,
                        structured: storeData.structured_shopping,
                    },
                    description: product?.description,
                    options:
                        await exports.batchPresignProductsOptionsImageLinks(
                            product?.options
                        ),
                };

                return tmpData;
            })
        );

        return { response: reformattedData, store: storeFp };
    }

    //No products
    return { response: {}, store: storeFp };
};

exports.checkImageUrl = async (url) => {
    try {
        const redisKey = `${url}-checkedImage`;
        const cachedPresignedImage = await Redis.get(redisKey);

        if (!cachedPresignedImage) {
            const response = await axios.get(url, {
                responseType: 'stream',
            });

            const isImageValid =
                response.headers['content-type'].startsWith('image/');

            await Redis.set(
                redisKey,
                isImageValid ? url : 'false',
                'EX',
                7 * 24 * 3600
            );

            return isImageValid;
        }

        return cachedPresignedImage !== 'false';
    } catch (error) {
        console.error(`Error:${url}`);
        return false;
    }
};

exports.checkAllImages = async (products, limit = 1000) =>
    async.mapLimit(products, limit, async (product) => {
        const isImageAvailable = await exports.checkImageUrl(
            product.pictures[0]
        );

        product.pictures = [!isImageAvailable ? 'false' : product.pictures[0]];
        return product;
    });

exports.checkBlurriness = async (url) => {
    try {
        const redisKey = `${url}-checkedBlurryImage`;
        let cachedBlurryCheckedImage = await Redis.get(redisKey);

        if (!cachedBlurryCheckedImage) {
            const response = await axios.post(
                'http://18.204.117.172:7575/check',
                {
                    imageUrl: url,
                }
            );

            if (response.data?.message) {
                await Redis.set(
                    redisKey,
                    JSON.stringify(response.data),
                    'EX',
                    7 * 24 * 3600
                );
                return response.data;
            }

            return null;
        }

        return JSON.parse(cachedBlurryCheckedImage);
    } catch (error) {
        console.error(error);
        return null;
    }
};

exports.checkAllImagesBluriness = async (products, limit = 1000) =>
    async.mapLimit(products, limit, async (product) => {
        const blurriness = await exports.checkBlurriness(product.pictures[0]);

        product.isBlurry = !blurriness ? false : blurriness?.blurScore > 1.5;

        return product;
    });
