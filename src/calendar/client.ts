import { google, type calendar_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type CalendarClient = calendar_v3.Calendar;

export function createCalendarClient(auth: OAuth2Client): CalendarClient {
  return google.calendar({ version: "v3", auth });
}
