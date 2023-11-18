/* eslint-disable import/no-extraneous-dependencies */
const sgMail = require('@sendgrid/mail');
const Bull = require('bull');

// Set the SendGrid API Key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Creating a new Bull Queue for email jobs
const emailQueue = new Bull('emailQueue');

// Process the email jobs in the queue
emailQueue.process(async (job) => {
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

// Event listener when a job is completed
emailQueue.on('completed', (job, result) => {
    console.log(`Job completed with ID ${job.id}`);
});

// Event listener when a job fails
emailQueue.on('failed', (job, err) => {
    console.log(`Job failed with ID ${job.id} and error: ${err}`);
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
    emailQueue.add({
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
