import type { GmailAgentDatabase } from "../database.js";
import type { CalendarLink } from "../../core/models.js";

interface CalendarLinkRow {
  account_hash: string;
  gmail_message_id: string;
  candidate_index: number;
  calendar_event_id: string;
  payload_hash: string;
  etag: string | null;
  status: string;
  created_at: string;
}

function fromRow(row: CalendarLinkRow): CalendarLink {
  return {
    accountHash: row.account_hash,
    gmailMessageId: row.gmail_message_id,
    candidateIndex: row.candidate_index,
    calendarEventId: row.calendar_event_id,
    payloadHash: row.payload_hash,
    etag: row.etag,
    status: row.status as CalendarLink["status"],
    createdAt: row.created_at
  };
}

export class CalendarLinksRepository {
  constructor(private readonly db: GmailAgentDatabase) {}

  get(accountHash: string, gmailMessageId: string, candidateIndex: number): CalendarLink | null {
    const row = this.db
      .prepare(
        "SELECT * FROM calendar_links WHERE account_hash = ? AND gmail_message_id = ? AND candidate_index = ?"
      )
      .get(accountHash, gmailMessageId, candidateIndex) as CalendarLinkRow | undefined;
    return row ? fromRow(row) : null;
  }

  upsert(link: CalendarLink): void {
    this.db
      .prepare(
        `INSERT INTO calendar_links (account_hash, gmail_message_id, candidate_index, calendar_event_id, payload_hash, etag, status, created_at)
         VALUES (@accountHash, @gmailMessageId, @candidateIndex, @calendarEventId, @payloadHash, @etag, @status, @createdAt)
         ON CONFLICT(account_hash, gmail_message_id, candidate_index) DO UPDATE SET
           calendar_event_id = excluded.calendar_event_id,
           payload_hash = excluded.payload_hash,
           etag = excluded.etag,
           status = excluded.status`
      )
      .run({
        accountHash: link.accountHash,
        gmailMessageId: link.gmailMessageId,
        candidateIndex: link.candidateIndex,
        calendarEventId: link.calendarEventId,
        payloadHash: link.payloadHash,
        etag: link.etag,
        status: link.status,
        createdAt: link.createdAt
      });
  }
}
