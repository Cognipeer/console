import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const log = createLogger('email');

type HandlebarsInstance = typeof import('handlebars');

let handlebarsPromise: Promise<HandlebarsInstance> | null = null;

async function getHandlebars(): Promise<HandlebarsInstance> {
  if (!handlebarsPromise) {
    handlebarsPromise = import('handlebars/dist/cjs/handlebars').then((module) => module.default);
  }

  return handlebarsPromise;
}

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

    const cfg = getConfig();
    const smtpConfig = {
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: {
        user: cfg.smtp.user,
        pass: cfg.smtp.pass,
      },
    };

    if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
      log.warn('SMTP credentials not configured. Emails will not be sent.');
      return null;
    }

    this.transporter = nodemailer.createTransport(smtpConfig);
    return this.transporter;
  }

  async loadTemplate(
    templateName: string,
    data: Record<string, unknown>,
  ): Promise<EmailTemplate> {
    const templatePath = path.join(
      process.cwd(),
      'mail-templates',
      `${templateName}.html`,
    );

    try {
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      const handlebars = await getHandlebars();
      const template = handlebars.compile(templateContent);
      const html = template(data);

      // Extract subject from template (first line should be: <!-- subject: Your Subject -->)
      const subjectMatch = templateContent.match(
        /<!--\s*subject:\s*(.+?)\s*-->/i,
      );
      const rawSubject = subjectMatch
        ? subjectMatch[1]
        : 'Notification from Cognipeer Console';
      // Compile subject through Handlebars so template variables (e.g. {{alertName}}) are resolved
      const subject = handlebars.compile(rawSubject)(data);

      return { subject, html };
    } catch (error) {
      log.error(`Failed to load email template ${templateName}`, { error });
      throw new Error(`Email template ${templateName} not found`);
    }
  }

  async send(
    to: string,
    templateName: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const transporter = await this.getTransporter();

      if (!transporter) {
        log.info(`Email simulation: would send ${templateName} to ${to}`);
        return false;
      }

      const { subject, html } = await this.loadTemplate(templateName, data);
      const cfg = getConfig();

      await transporter.sendMail({
        from: cfg.smtp.from,
        to,
        subject,
        html,
      });

      log.info(`Email sent to ${to}`, { template: templateName });
      return true;
    } catch (error) {
      log.error('Failed to send email', { error, to, template: templateName });
      return false;
    }
  }
}

const emailService = new EmailService();

export async function sendEmail(
  to: string,
  templateName: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return emailService.send(to, templateName, data);
}
