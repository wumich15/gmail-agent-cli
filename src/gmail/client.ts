import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type GmailClient = gmail_v1.Gmail;

export function createGmailClient(auth: OAuth2Client): GmailClient {
  return google.gmail({ version: "v1", auth });
}
