import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';

export interface EmailTemplate {
  subject: string;
  html: string;
}

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  private async getTransporter() {
    if (this.transporter) {
      return this.transporter;
    }

    const config = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    };

    if (!config.auth.user || !config.auth.pass) {
      console.warn('SMTP credentials not configured. Emails will not be sent.');
      return null;
    }

    this.transporter = nodemailer.createTransport(config);
    return this.transporter;
  }

  async loadTemplate(
    templateName: string,
    data: Record<string, any>,
  ): Promise<EmailTemplate> {
    const templatePath = path.join(
      process.cwd(),
      'mail-templates',
      `${templateName}.html`,
    );

    try {
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      const template = Handlebars.compile(templateContent);
      const html = template(data);

      // Extract subject from template (first line should be: <!-- subject: Your Subject -->)
      const subjectMatch = templateContent.match(
        /<!--\s*subject:\s*(.+?)\s*-->/i,
      );
      const subject = subjectMatch
        ? subjectMatch[1]
        : 'Notification from CognipeerAI Gateway';

      return { subject, html };
    } catch (error) {
      console.error(`Failed to load email template ${templateName}:`, error);
      throw new Error(`Email template ${templateName} not found`);
    }
  }

  async send(
    to: string,
    templateName: string,
    data: Record<string, any>,
  ): Promise<boolean> {
    try {
      const transporter = await this.getTransporter();

      if (!transporter) {
        console.log(`[Email Simulation] Would send ${templateName} to ${to}`);
        return false;
      }

      const { subject, html } = await this.loadTemplate(templateName, data);

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        html,
      });

      console.log(`✅ Email sent successfully to ${to}`);
      return true;
    } catch (error) {
      console.error('Failed to send email:', error);
      return false;
    }
  }
}

const emailService = new EmailService();

export async function sendEmail(
  to: string,
  templateName: string,
  data: Record<string, any>,
): Promise<boolean> {
  return emailService.send(to, templateName, data);
}
