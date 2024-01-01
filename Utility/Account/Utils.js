const { v4: uuidv4 } = require('uuid');
const otpGenerator = require('otp-generator');
const bcrypt = require('bcrypt');
const { logger } = require('../../LogService');
const UserModel = require('../../models/UserModel');
const { shouldSendNewSMS } = require('../Utils');
const {
    getCorporateBalance,
    giveFreeSignupCredits,
} = require('../Wallet/Utils');
const { sendEmail } = require('../sendEmail');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

//! PLANS QUOTAS
const QUOTAS_DESTINATIONS = {
    // Starter: 5,
    // Intermediate: 10,
    // Pro: 15,
    Starter: 5000,
    Intermediate: 5000,
    Pro: 5000,
    PRSNLD: 15,
};

/**
 * @func performCorporateDeliveryAccountAuthOps
 * Responsible not only for creating but also to handle any type of authentication to the
 * corporate delivery accounts.
 * @param inputData: any kind of essential data need of auth (email, pass, etc)
 * @param resolve
 */
exports.performCorporateDeliveryAccountAuthOps = async (inputData) => {
    const {
        email,
        first_name: firstName,
        last_name: lastName,
        phone,
        company_name: companyName,
        selected_industry: selectedIndustry,
        password,
        op,
        company_fp: companyFp,
        otp,
    } = inputData;

    try {
        //? SIGNUP
        if (/signup/i.test(op)) {
            if (
                email &&
                firstName &&
                lastName &&
                phone &&
                companyName &&
                selectedIndustry &&
                password
            ) {
                const companyNameFormatted = companyName.trim().toUpperCase();
                const emailFormatted = email.trim().toLowerCase();
                const companyId = uuidv4();

                const company = await UserModel.query('email')
                    .eq(emailFormatted)
                    .exec();

                const checkCompanyPhone = await UserModel.query('phone_number')
                    .eq(phone)
                    .exec();
                const checkCompanyName = await UserModel.query('company_name')
                    .eq(companyNameFormatted)
                    .exec();

                if (
                    company.count <= 0 &&
                    checkCompanyPhone.count <= 0 &&
                    checkCompanyName.count <= 0
                ) {
                    //? Create stripe user
                    const stripeCustomer = await stripe.customers.create({
                        email: emailFormatted,
                    });
                    const salt = await bcrypt.genSalt(10);
                    const hashedPassword = await bcrypt.hash(password, salt);

                    //New account
                    const accountObj = {
                        id: companyId,
                        company_name: companyNameFormatted,
                        password: hashedPassword,
                        email: emailFormatted,
                        phone_number: phone,
                        name: firstName,
                        surname: lastName,
                        plans: {
                            subscribed_plan: false,
                            isPlan_active: false,
                        },
                        account: {
                            registration_state: 'notFull',
                            confirmations: {
                                isPhoneConfirmed: false,
                                isEmailConfirmed: false,
                                isIDConfirmed: false,
                            },
                        },
                        selected_industry: selectedIndustry,
                        stripe_customerId: stripeCustomer.id,
                    };

                    const newCompany = await UserModel.create(accountObj);

                    //? Give free signup credits
                    await giveFreeSignupCredits(companyId);

                    await sendEmail({
                        email: emailFormatted,
                        fromName: 'DulcetDash',
                        fromEmail: 'no-reply@dulcetdash.com',
                        subject: 'N$100 in Credits for 2 Free Deliveries!',
                        templateId: 'd-b31e9d567bf44028a84f0e172bfd9b11',
                        dynamicTemplateData: {
                            customer_name: companyNameFormatted,
                        },
                    });

                    return {
                        response: 'successfully_created',
                        metadata: {
                            company_fp: newCompany.id,
                            phone: newCompany.phone_number,
                            ...newCompany,
                        },
                    };
                } //Account already exists

                logger.warn('Account already exists');
                return {
                    response: 'error_creating_account_alreadyExists',
                };
            } //Invalid signup data provided

            logger.warn('Invalid signup data provided');
            return { response: 'error' };
        }

        //? LOGIN
        if (/login/i.test(op)) {
            if (email && password) {
                const company = await UserModel.query('email').eq(email).exec();

                if (company.count > 0) {
                    const companyData = company[0];

                    if (!companyData?.company_name) {
                        return {
                            response: 'error_logging_in_notFoundAccount',
                        };
                    }

                    const responseFinal = {
                        response: 'successfully_logged_in',
                        metadata: {
                            company_name: companyData.company_name,
                            company_fp: companyData.id,
                            email: companyData.email,
                            phone: companyData.phone_number,
                            user_registerer: {
                                first_name: companyData.name,
                                last_name: companyData.surname,
                            },
                            plans: {},
                            account: companyData.account,
                            stripe_customerId: companyData?.stripe_customerId,
                        },
                    };

                    const wallet = await getCorporateBalance(companyData.id);
                    responseFinal.metadata.plans = {
                        ...companyData.plans,
                        ...wallet,
                    };
                    //! Attach the destination quotas
                    responseFinal.metadata.plans.delivery_limit =
                        wallet?.subscribed_plan
                            ? QUOTAS_DESTINATIONS[wallet?.subscribed_plan]
                            : 5000;

                    return responseFinal;
                }

                return {
                    response: 'error_logging_in_notFoundAccount',
                };
            } //Invalid data

            return { response: 'error_logging_in' };
        }

        //? RESENT CONFIRMATION SMS
        if (/resendConfirmationSMS/i.test(op)) {
            if (companyFp && phone) {
                const company = await UserModel.get(companyFp);

                if (company) {
                    //Company exists
                    await shouldSendNewSMS(company, phone, false, true);

                    return { response: 'successfully_sent' };
                }

                return { response: 'error' };
            } //Invalid data

            logger.warn(
                'Invalid data for resending the confirmation SMS detected'
            );
            return { response: 'error' };
        }

        //? UPDATE PHONE NUMBER
        if (/updatePhoneNumber/i.test(op)) {
            //Change the phone number
            if (companyFp && email) {
                //Check if the company exists
                const company = await UserModel.get(companyFp);

                if (company) {
                    //Company exists
                    //? Update the comapny's phone
                    const updatedCompany = await UserModel.update(
                        {
                            id: companyFp,
                        },
                        {
                            email,
                        }
                    );

                    const responseFinal = {
                        response: 'successfully_updated',
                        metadata: {
                            company_name: updatedCompany.company_name,
                            company_fp: updatedCompany.id,
                            email: updatedCompany.email,
                            phone: updatedCompany.phone,
                            user_registerer: {
                                first_name: updatedCompany.name,
                                last_name: updatedCompany.surname,
                            },
                            plans: {},
                            account: updatedCompany.account,
                        },
                    };

                    const wallet = await getCorporateBalance(updatedCompany.id);
                    responseFinal.metadata.plans = {
                        ...updatedCompany.plans,
                        ...wallet,
                    };
                    //! Attach the destination quotas
                    responseFinal.metadata.plans.delivery_limit =
                        wallet?.subscribed_plan
                            ? QUOTAS_DESTINATIONS[wallet?.subscribed_plan]
                            : 5000;

                    return responseFinal;
                }

                return { response: 'error' };
            } //Invalid data

            logger.warn('Invalid data for updating the phone detected');
            return { response: 'error' };
        }

        //? VALIDATE PHONE NUMBER
        if (/validatePhoneNumber/i.test(inputData.op)) {
            //Validate the phone number via SMS OTP
            if (companyFp && phone && otp) {
                const company = await UserModel.get(companyFp);

                if (company) {
                    //Company exists
                    //? Validate the OTP
                    if (company.otp === parseInt(otp, 10)) {
                        //Valid number
                        //? Update the account vars
                        await UserModel.update(
                            {
                                id: companyFp,
                            },
                            {
                                account: {
                                    confirmations: {
                                        isPhoneConfirmed: true,
                                    },
                                },
                            }
                        );

                        const responseFinal = {
                            response: 'successfully_validated',
                            metadata: {
                                company_name: company.company_name,
                                company_fp: company.id,
                                email: company.email,
                                phone: company.phone_number,
                                user_registerer: {
                                    first_name: company.name,
                                    last_name: company.surname,
                                },
                                plans: {},
                                account: company.account,
                                stripe_customerId: company.stripe_customerId,
                            },
                        };

                        const wallet = await getCorporateBalance(company.id);
                        responseFinal.metadata.plans = {
                            ...company.plans,
                            ...wallet,
                        };
                        //! Attach the destination quotas
                        responseFinal.metadata.plans.delivery_limit =
                            wallet?.subscribed_plan
                                ? QUOTAS_DESTINATIONS[wallet?.subscribed_plan]
                                : 5000;

                        return responseFinal;
                    } //Invalid code

                    return { response: 'invalid_code' };
                }

                return { response: 'invalid_code' };
            } //Invalid data

            logger.warn('Invalid data for validating the phone detected');
            return { response: 'error' };
        }

        //? GET ACCOUNT DATA
        if (/getAccountData/i.test(inputData.op)) {
            //Get the account details
            if (companyFp) {
                const company = await UserModel.get(companyFp);

                if (company) {
                    const responseFinal = {
                        response: 'authed',
                        metadata: {
                            company_name: company.company_name,
                            company_fp: company.id,
                            email: company.email,
                            phone: company.phone_number,
                            user_registerer: {
                                firstName: company.name,
                                lastName: company.surname,
                            },
                            plans: {},
                            account: company.account,
                            stripe_customerId: company.stripe_customerId,
                        },
                    };

                    const wallet = await getCorporateBalance(company.id);
                    responseFinal.metadata.plans = {
                        ...company.plans,
                        ...wallet,
                    };
                    //! Attach the destination quotas
                    responseFinal.metadata.plans.delivery_limit =
                        wallet?.subscribed_plan
                            ? QUOTAS_DESTINATIONS[wallet?.subscribed_plan]
                            : 5000;

                    return responseFinal;
                }

                return { response: 'error' };
            }

            logger.warn('Invalid data for getting the account data.');
            return { response: 'error' };
        }
        //Invalid op

        logger.warn('Invalid op detected');
        return { response: 'error' };
    } catch (error) {
        logger.error(error);
        return { response: 'error' };
    }
};
