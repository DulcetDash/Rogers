require('dotenv').config();
/* eslint-disable import/no-extraneous-dependencies */
const sgMail = require('@sendgrid/mail');
const { sendMailQueue } = require('./bullJobs');

// Set the SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Process the email jobs in the queue
sendMailQueue.process(async (job) => {
    const {
        email,
        fromEmail = 'support@dulcetdash.com',
        fromName,
        message,
        subject,
        templateId, // Assuming SendGrid template ID
        dynamicTemplateData,
        attachments,
    } = job.data;

    const msg = {
        to: email,
        from: { email: fromEmail, name: fromName },
        subject: subject,
        text: message,
        templateId: templateId,
        dynamicTemplateData: dynamicTemplateData,
        attachments: attachments,
    };

    // Send the email
    try {
        await sgMail.send(msg);
        console.log(`Email sent to ${email}`);
    } catch (error) {
        console.error(`Error sending email to ${email}:`, error);
        throw error;
    }
});

/**
 * @description Retry email jobs if they fail or clean the queue if they fail too many times
 *
 * @param job - The job that failed
 * @param error - The error that caused the job to fail
 *
 */
const retryEmailJobs = (job, error) => {
    console.error(`Job ${job.id} failed with the following error:`, error);
    if (job.attemptsMade >= 4) {
        job.remove();
    } else {
        setTimeout(async () => {
            if (job?.retry) {
                await job.retry();
            }
        }, 100 ** job.attemptsMade);
    }
};

/**
 * @description Get and remove a job from the sendMailQueueSG Bull queue
 * @param jobId
 * @param queueName
 */
const getAndRemoveEmailJob = async (jobId) => {
    const job = await sendMailQueue.getJob(jobId);
    if (job) {
        await job.remove();
    }
};

// Event listener when a job is completed
sendMailQueue.on('global:completed', async (jobId, result) => {
    console.log(`Job completed with ID ${jobId}`);
    await getAndRemoveEmailJob(jobId);
});

// Event listener when a job fails
sendMailQueue.on('failed', (job, error) => {
    console.log(`Job failed with ID ${job.id} and error: ${error}`);
    retryEmailJobs(job, error);
});

// Function to add an email to the queue
const sendEmail = ({
    email,
    fromEmail,
    fromName,
    message,
    subject,
    templateId,
    dynamicTemplateData = {},
    attachments = [],
}) => {
    sendMailQueue.add({
        email,
        fromEmail,
        fromName,
        message,
        subject,
        templateId,
        dynamicTemplateData,
        attachments,
    });
};

module.exports = sendEmail;
