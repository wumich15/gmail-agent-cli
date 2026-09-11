import { describe, expect, it } from "vitest";
import {
  VIEW_FOLDERS,
  adjacentViewFolder,
  folderForLabelSnapshot,
  isViewCacheMessage,
  messageIsInViewFolder,
  viewFolderSupportsSearch,
  viewFolderDefinition
} from "../../src/gmail/view-folders.js";

describe("gmail view folders", () => {
  it("keeps the top-bar order stable and wraps left/right navigation", () => {
    expect(VIEW_FOLDERS.map(({ id }) => id)).toEqual(["inbox", "archive", "trash", "spam"]);

    expect(adjacentViewFolder("inbox", "right")).toBe("archive");
    expect(adjacentViewFolder("archive", "right")).toBe("trash");
    expect(adjacentViewFolder("trash", "right")).toBe("spam");
    expect(adjacentViewFolder("spam", "right")).toBe("inbox");

    expect(adjacentViewFolder("inbox", "left")).toBe("spam");
    expect(adjacentViewFolder("spam", "left")).toBe("trash");
    expect(adjacentViewFolder("trash", "left")).toBe("archive");
    expect(adjacentViewFolder("archive", "left")).toBe("inbox");
  });

  it("maps each folder to the Gmail list parameters needed to hydrate it", () => {
    expect(viewFolderDefinition("inbox").list).toEqual({
      labelIds: ["INBOX"],
      includeSpamTrash: false
    });
    expect(viewFolderDefinition("archive").list).toEqual({
      q: "in:archive",
      includeSpamTrash: false
    });
    expect(viewFolderDefinition("trash").list).toEqual({
      labelIds: ["TRASH"],
      includeSpamTrash: true
    });
    expect(viewFolderDefinition("spam").list).toEqual({
      labelIds: ["SPAM"],
      includeSpamTrash: true
    });
  });

  it("uses Trash, Spam, Inbox, then Archive precedence for odd multi-label snapshots", () => {
    expect(folderForLabelSnapshot(["TRASH", "SPAM", "INBOX"])).toBe("trash");
    expect(folderForLabelSnapshot(["SPAM", "INBOX"])).toBe("spam");
    expect(folderForLabelSnapshot(["INBOX", "STARRED"])).toBe("inbox");
    expect(folderForLabelSnapshot(["UNREAD", "STARRED"])).toBe("archive");

    expect(messageIsInViewFolder(["TRASH", "INBOX"], "trash")).toBe(true);
    expect(messageIsInViewFolder(["TRASH", "INBOX"], "inbox")).toBe(false);
  });

  it("excludes Sent- and Draft-only mail while retaining explicit mailbox locations", () => {
    expect(folderForLabelSnapshot(["SENT"])).toBeNull();
    expect(folderForLabelSnapshot(["DRAFT", "STARRED"])).toBeNull();
    expect(isViewCacheMessage(["SENT"])).toBe(false);
    expect(isViewCacheMessage(["DRAFT"])).toBe(false);

    expect(folderForLabelSnapshot(["SENT", "INBOX"])).toBe("inbox");
    expect(folderForLabelSnapshot(["DRAFT", "TRASH"])).toBe("trash");
  });

  it("keeps subject/sender search restricted to Inbox", () => {
    expect(viewFolderSupportsSearch("inbox")).toBe(true);
    expect(viewFolderSupportsSearch("archive")).toBe(false);
    expect(viewFolderSupportsSearch("trash")).toBe(false);
    expect(viewFolderSupportsSearch("spam")).toBe(false);
  });
});
