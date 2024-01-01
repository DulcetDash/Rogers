const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');

const Payments = require('../../models/Payments');
const { getHumReadableWalletTrxDescription } = require('../Utils');
const { logger } = require('../../LogService');
const Subscriptions = require('../../models/Subscriptions');

exports.getBalance = async (userId) => {
    try {
        const transactions = await Payments.query('user_id')
            .eq(userId)
            .all()
            .exec();

        const totalTopup = transactions
            .filter(
                (transaction) =>
                    transaction.transaction_description === 'WALLET_TOPUP' ||
                    transaction.transaction_description === 'SIGNUP_CREDITS'
            )
            .reduce((acc, curr) => acc + curr.amount, 0);

        const totalUsed = transactions
            .filter(
                (transaction) =>
                    transaction?.success || transaction?.success === undefined
            )
            .filter(
                (transaction) =>
                    transaction.transaction_description === 'GROCERY_PAYMENT' ||
                    transaction.transaction_description ===
                        'PACKAGE_DELIVERY_PAYMENT'
            )
            .reduce((acc, curr) => acc + curr.amount, 0);

        let transactionHistory = transactions.map((transaction) => ({
            id: transaction.id,
            amount: transaction.amount,
            description: getHumReadableWalletTrxDescription(
                transaction.transaction_description
            ),
            success: transaction?.success ?? true,
            createdAt: transaction.createdAt,
        }));

        transactionHistory = _.orderBy(
            transactionHistory,
            ['createdAt'],
            ['desc']
        ).slice(0, 3);

        return {
            balance: totalTopup - totalUsed,
            transactionHistory,
        };
    } catch (error) {
        logger.error(error);
        return {
            balance: 0,
            transactionHistory: [],
        };
    }
};

exports.getCorporateBalance = async (userId) => {
    try {
        const balance = await exports.getBalance(userId);
        const subscriptions = await Subscriptions.query('user_id')
            .eq(userId)
            .filter('active')
            .eq(true)
            .exec();

        const subscription = subscriptions[0];

        return {
            ...balance,
            isPlan_active: subscription?.active ?? false,
            subscribed_plan: subscription?.transaction_description ?? '',
        };
    } catch (error) {
        logger.error(error);
        return {
            balance: 0,
            transactionHistory: [],
        };
    }
};

exports.giveFreeSignupCredits = async (userId) => {
    const amount = 100;

    const payment = new Payments({
        id: uuidv4(),
        user_id: userId,
        amount,
        currency: 'nad',
        transaction_description: 'SIGNUP_CREDITS',
    });

    return await payment.save();
};
