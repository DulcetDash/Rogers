const { v4: uuidv4 } = require('uuid');
const otpGenerator = require('otp-generator');
const bcrypt = require('bcrypt');
const { logger } = require('../../LogService');
const UserModel = require('../../models/UserModel');

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

                if (company.count <= 0) {
                    const salt = await bcrypt.genSalt(10);
                    const hashedPassword = await bcrypt.hash(password, salt);

                    //New account
                    const accountObj = {
                        id: companyId,
                        company_name: companyNameFormatted,
                        password: hashedPassword,
                        email: emailFormatted,
                        phone: phone,
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
                    };

                    const newCompany = await UserModel.create(accountObj);

                    return {
                        response: 'successfully_created',
                        metadata: newCompany,
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

                    return {
                        response: 'successfully_logged_in',
                        metadata: {
                            company_name: companyData.company_name,
                            company_fp: companyData.company_fp,
                            email: companyData.email,
                            phone: companyData.phone,
                            user_registerer: companyData.user_registerer,
                            plans: companyData.plans,
                            account: companyData.account,
                        },
                    };
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
                    let otp = otpGenerator.generate(5, {
                        lowerCaseAlphabets: false,
                        upperCaseAlphabets: false,
                        specialChars: false,
                    });
                    //! --------------
                    otp = String(otp).length < 5 ? parseInt(otp, 10) * 10 : otp;

                    await UserModel.update(
                        {
                            id: companyFp,
                        },
                        {
                            otp,
                        }
                    );

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
            if (companyFp && phone) {
                //Check if the company exists
                const company = await UserModel.get(companyFp);

                if (company) {
                    //Company exists
                    //? Update the comapny's phone
                    await UserModel.update(
                        {
                            id: companyFp,
                        },
                        {
                            phone,
                        }
                    );

                    return {
                        response: 'successfully_updated',
                        metadata: {
                            company_name: company.company_name,
                            company_fp: company.company_fp,
                            email: company.email,
                            phone: company.phone,
                            user_registerer: company.user_registerer,
                            plans: company.plans,
                            account: company.account,
                        },
                    };
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

                        return {
                            response: 'successfully_validated',
                            metadata: {
                                company_name: company.company_name,
                                company_fp: company.company_fp,
                                email: company.email,
                                phone: company.phone,
                                user_registerer: company.user_registerer,
                                plans: company.plans,
                                account: company.account,
                            },
                        };
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
                //! PLANS QUOTAS
                const QUOTAS_DESTINATIONS = {
                    STR: 5,
                    ITMD: 10,
                    PR: 15,
                    PRSNLD: 15,
                };

                const company = await UserModel.get(companyFp);

                if (company) {
                    const responseFinal = {
                        response: 'authed',
                        metadata: {
                            company_name: company.company_name,
                            company_fp: company.id,
                            email: company.email,
                            phone: company.phone,
                            user_registerer: company.user_registerer,
                            plans: company.plans,
                            account: company.account,
                            wallet: {},
                        },
                    };
                    // responseFinal.metadata['wallet'] = body;
                    //! Attach the destination quotas
                    responseFinal.metadata.plans.delivery_limit =
                        QUOTAS_DESTINATIONS[company.plans.subscribed_plan];

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
