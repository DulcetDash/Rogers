const _ = require('lodash');
const Payments = require('../../models/Payments');
const { getHumReadableWalletTrxDescription } = require('../Utils');
const { logger } = require('../../LogService');

exports.getBalance = async (userId) => {
    try {
        const transactions = await Payments.query('user_id')
            .eq(userId)
            .all()
            .exec();

        const totalTopup = transactions
            .filter(
                (transaction) =>
                    transaction.transaction_description === 'WALLET_TOPUP'
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
