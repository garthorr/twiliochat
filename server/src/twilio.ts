import twilio from "twilio";
import type { TwilioConfig } from "./config.js";

export interface SendResult {
  sid: string;
  status: string;
}

export interface SmsSender {
  send(opts: {
    to: string;
    from: string;
    body: string;
    statusCallback?: string;
    mediaUrl?: string[];
  }): Promise<SendResult>;
}

export function createTwilioSender(config: TwilioConfig): SmsSender {
  const client = twilio(config.accountSid, config.authToken);
  return {
    async send(opts) {
      const message = await client.messages.create({
        to: opts.to,
        from: opts.from,
        body: opts.body,
        ...(opts.statusCallback ? { statusCallback: opts.statusCallback } : {}),
        ...(opts.mediaUrl?.length ? { mediaUrl: opts.mediaUrl } : {}),
      });
      return { sid: message.sid, status: message.status };
    },
  };
}
