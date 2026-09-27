// "Via ChatGPT" mode: the user runs the prompt in their own ChatGPT app (no API key needed),
// then pastes the reply back. We build the prompt and parse the reply deterministically — no AI call here.
import { z } from "zod";
import { HttpError } from "../config.js";
import { DRAFT_SYSTEM, EXTRACT_SYSTEM, profileBlock, type ProfileForPrompt } from "./ai/index.js";

export function buildChatGptPrompt(profile: ProfileForPrompt, notes?: string) {
  return `I'm attaching a screenshot of a LinkedIn hiring post (or I've pasted the post below). Read it and write my job application email.

STEP 1 — extract the job details:
${EXTRACT_SYSTEM}

STEP 2 — write the email:
${DRAFT_SYSTEM}

MY PROFILE:
${profileBlock(profile)}
${notes ? `\nNotes for this application: ${notes}\n` : ""}
REPLY FORMAT — reply with ONLY this block, exactly these labels, no markdown, nothing before or after:

===JOB===
Company: <company name>
Role: <job title>
Contact email: <email address to apply to, or NONE>
Summary: <2-4 sentence summary of the role>
===EMAIL===
Subject: <subject line>
Body:
<full email body>
===END===`;
}

export interface ParsedReply {
  company: string;
  role: string;
  contact_email: string | null;
  job_summary: string;
  subject: string;
  body: string;
}

const clean = (s: string) => s.replace(/\*\*|__/g, "").trim();

function field(block: string, label: string): string {
  const re = new RegExp(`^[\\s>*_-]*${label}[\\s*_]*:[\\s*_]*(.*)$`, "im");
  return clean(block.match(re)?.[1] ?? "");
}

/** Parses the ===JOB=== / ===EMAIL=== block, tolerating code fences, bold labels, and missing markers. */
export function parseChatGptReply(raw: string): ParsedReply {
  const text = raw.replace(/\r\n/g, "\n").replace(/^```[a-z]*\n?|```$/gim, "");
  const emailStart = text.search(/={2,}\s*EMAIL\s*={2,}/i);
  const jobPart = emailStart >= 0 ? text.slice(0, emailStart) : text;
  const emailPart = emailStart >= 0 ? text.slice(emailStart) : text;

  const subject = field(emailPart, "Subject");
  const bodyLabel = emailPart.match(/^[ \t>]*[*_]*Body[*_]*[ \t]*:[*_ \t]*/im);
  let body = bodyLabel ? emailPart.slice((bodyLabel.index ?? 0) + bodyLabel[0].length) : "";
  const end = body.search(/={2,}\s*END\s*={2,}/i);
  if (end >= 0) body = body.slice(0, end);
  body = body.replace(/^\s*\n/, "").replace(/\s+$/, "");

  if (!subject || !body) {
    throw new HttpError(
      422,
      "Couldn't find the Subject and Body in that reply. Make sure you pasted ChatGPT's whole answer, or ask ChatGPT to 'use the exact reply format'.",
    );
  }

  const emailRaw = field(jobPart, "Contact email").match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/i)?.[0] ?? null;
  const contactEmail = emailRaw && z.email().safeParse(emailRaw).success ? emailRaw : null;

  return {
    company: field(jobPart, "Company"),
    role: field(jobPart, "Role"),
    contact_email: contactEmail,
    job_summary: field(jobPart, "Summary"),
    subject: subject.replace(/[\r\n]+/g, " "),
    body,
  };
}
