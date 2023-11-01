/* eslint-disable import/no-extraneous-dependencies */
const nodemailer = require('nodemailer');
const Bull = require('bull');

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
        templateType,
        dynamicTemplateData,
        attachments,
    } = job.data;

    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_POST,
        secure: false,
        auth: {
            user: process.env.EMAIL_USERNAME,
            pass: process.env.EMAIL_PASSWORD,
        },
    });

    const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: email,
        text: message,
        subject,
        dynamicTemplateData,
        attachments,
    };

    // Send the email
    await transporter.sendMail(mailOptions);
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
    templateType,
    dynamicTemplateData = {},
    attachments = [],
}) => {
    emailQueue.add({
        email,
        fromEmail,
        fromName,
        message,
        subject,
        templateType,
        dynamicTemplateData,
        attachments,
    });
};

module.exports = sendEmail;
