#!/usr/bin/env python3
"""
Regenerate LinkedIn outreach messages using Gary's outreach style guide.
Reads briefs from step6, sends to Anthropic API, outputs new drafts.

Usage:
  python3 regenerate-messages.py --type reengagement [--limit N] [--dry-run]
  python3 regenerate-messages.py --type cold [--limit N] [--dry-run]
  python3 regenerate-messages.py --type all [--limit N] [--dry-run]
"""

import json
import os
import sys
import time
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Load API key from gbrain config
config_path = Path.home() / ".gbrain" / "config.json"
with open(config_path) as f:
    config = json.load(f)

ANTHROPIC_API_KEY = config["anthropic_api_key"]

# Style guide (baked in, not read from file, so script is self-contained)
STYLE_GUIDE = """
# Gary's Outreach & Messaging Style

## Core Rules
- ALWAYS open with "Aloha [FirstName]," (comma after name)
- Warm tone everywhere. There is NO "cold outreach" mode. Same personality for strangers and old friends.
- Relationship first. NEVER pitch, promote, or link to articles in the first message.
- Be specific - reference something concrete about the person, their role, or shared context.
- Humor: self-deprecating, situational, dry. Never forced. Often references the person's role/industry playfully.
- Keep it short: 2-4 sentences max. This is a conversation opener, not an essay.
- NO Substack links, NO article mentions, NO "I wrote about..." in the first message.
- NO self-introductions ("I'm Gary, a fintech advisor who..."). They already connected with you.
- NO generic flattery ("I'm impressed by your profile").
- NO corporate language ("synergies", "leverage", "touch base").
- NO fake enthusiasm ("SO EXCITED to connect!!!").
- Close warmly but briefly. "Have a great day!" or similar, or just end naturally.
- For Hungarian contacts: you may use Hungarian language, "Na", "Koszi", casual slang.

## Message Structure
1. "Aloha [FirstName],"
2. Light joke, observation, or warm acknowledgment (1 sentence)
3. Specific question about THEM - their work, their company, their situation (1-2 sentences)
4. Optional brief warm close

## What Makes a Good Question
- Specific enough that a generic answer won't work
- Shows you know something about their role/company
- Invites real conversation, not a yes/no
- About THEM, not about you

## Examples of Gary's Real Messages

Re-engagement (former Mambu colleague):
"Aloha Isaac, saw you checking in on my profile - hope that means you're doing well and not that I'm being subpoenaed. It's been way too long since we caught up. How's everything? Still keeping Thredd's APAC side out of trouble?"

Re-engagement (long gap):
"Aloha Renan! How are you! Haven't spoke for a decade..."

New community connection:
"Aloha [Name], Welcome to Lenny's podcast community! Is there anything you're working on right now that genuinely energizes or inspires you? Have a wonderful day!"
"""

RE_ENGAGEMENT_SYSTEM = f"""You are drafting a LinkedIn re-engagement message from Gary Orendi to a former contact.

{STYLE_GUIDE}

## Re-engagement Specifics
- This person has messaged with Gary before. Reference the relationship naturally.
- If you have a last message snippet, you can reference it - but don't force it.
- Acknowledge the time gap if it's been a while (>60 days), but keep it light.
- The goal is to restart the conversation, nothing more.

Output ONLY the message text. No headers, no metadata, no quotes, no markdown formatting."""

COLD_OUTREACH_SYSTEM = f"""You are drafting a LinkedIn message from Gary Orendi to a connection he's never messaged before.

{STYLE_GUIDE}

## First-message Specifics
- These people are already LinkedIn connections but have never exchanged messages.
- Since there's no shared history to reference, anchor on their role, company, or industry.
- The question should show you've thought about their specific situation.
- Keep it even shorter than re-engagement - 2-3 sentences max. Less is more for a first touch.

Output ONLY the message text. No headers, no metadata, no quotes, no markdown formatting."""


def build_re_engagement_prompt(brief):
    """Build the user prompt for a re-engagement message."""
    parts = [f"Draft a re-engagement message to {brief['name']}."]
    parts.append(f"Position: {brief['position']} at {brief['company']}")
    parts.append(f"Last messaged: {brief['days_ago']} days ago")
    parts.append(f"Total messages exchanged: {brief['message_count']}")

    if brief.get("last_message_snippet"):
        parts.append(f"Last message snippet: {brief['last_message_snippet'][:200]}")

    if brief.get("firm_type"):
        parts.append(f"Industry: {brief['firm_type']}")

    if brief.get("function_tag"):
        parts.append(f"Function: {brief['function_tag']}")

    return "\n".join(parts)


def build_cold_prompt(brief):
    """Build the user prompt for a cold outreach message."""
    parts = [f"Draft a first message to {brief['name']}."]
    parts.append(f"Position: {brief.get('position', 'Unknown')} at {brief.get('company', 'Unknown')}")

    if brief.get("firm_type"):
        parts.append(f"Industry: {brief['firm_type']}")

    if brief.get("function_tag"):
        parts.append(f"Function: {brief['function_tag']}")

    if brief.get("seniority"):
        parts.append(f"Seniority: {brief['seniority']}")

    return "\n".join(parts)


def call_anthropic(system_prompt, user_prompt, retries=3):
    """Call Anthropic API using urllib (no SDK dependency)."""
    import urllib.request
    import urllib.error

    payload = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": 300,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode()

    headers = {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    }

    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=payload,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read())
                return result["content"][0]["text"].strip()
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            if e.code == 429:
                wait = min(2 ** attempt * 5, 60)
                print(f"  Rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            elif e.code == 529:
                wait = min(2 ** attempt * 10, 120)
                print(f"  API overloaded, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            else:
                print(f"  HTTP {e.code}: {body[:200]}", file=sys.stderr)
                if attempt < retries - 1:
                    time.sleep(2)
                    continue
                raise
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            raise

    return None


def process_re_engagement(briefs, limit=None, dry_run=False):
    """Process re-engagement messages."""
    # Filter to needs_reply contacts that were in the original drafts
    original_drafts = json.load(open("/tmp/step7-v2-drafts.json"))
    original_slugs = {d["slug"] for d in original_drafts}
    filtered = [b for b in briefs if b["slug"] in original_slugs]
    filtered.sort(key=lambda x: x.get("score", 0), reverse=True)

    if limit:
        filtered = filtered[:limit]

    print(f"Re-engagement: {len(filtered)} messages to generate")

    results = []
    for i, brief in enumerate(filtered):
        if dry_run:
            prompt = build_re_engagement_prompt(brief)
            print(f"\n--- #{i+1}: {brief['name']} ---")
            print(f"Prompt: {prompt[:200]}...")
            results.append({**brief, "draft_message": "[DRY RUN]"})
            continue

        prompt = build_re_engagement_prompt(brief)
        draft = call_anthropic(RE_ENGAGEMENT_SYSTEM, prompt)

        if draft:
            # Find original to preserve knowledge_used and substack_link
            orig = next((d for d in original_drafts if d["slug"] == brief["slug"]), {})
            results.append({
                "slug": brief["slug"],
                "name": brief["name"],
                "position": brief["position"],
                "company": brief["company"],
                "days_ago": brief["days_ago"],
                "message_count": brief["message_count"],
                "score": brief.get("score", 0),
                "draft_message": draft,
                "knowledge_used": orig.get("knowledge_used", ""),
                "substack_link": orig.get("substack_link"),
            })
            print(f"  [{i+1}/{len(filtered)}] {brief['name']} - done")
        else:
            print(f"  [{i+1}/{len(filtered)}] {brief['name']} - FAILED", file=sys.stderr)

        # Rate limiting: ~50 req/min for Sonnet
        if not dry_run and (i + 1) % 50 == 0:
            print(f"  Pausing 5s after {i+1} requests...")
            time.sleep(5)

    return results


def process_cold(briefs, limit=None, dry_run=False):
    """Process cold outreach messages."""
    original_drafts = json.load(open("/tmp/step7-cold-drafts.json"))
    original_slugs = {d["slug"] for d in original_drafts}

    # Build lookup from briefs by slug
    briefs_by_slug = {b["slug"]: b for b in briefs}

    # Use original drafts order and data, enriched with brief data
    filtered = []
    for od in original_drafts:
        entry = briefs_by_slug.get(od["slug"], od)
        entry["_orig"] = od
        filtered.append(entry)

    if limit:
        filtered = filtered[:limit]

    print(f"Cold outreach: {len(filtered)} messages to generate")

    results = []
    for i, item in enumerate(filtered):
        orig = item.pop("_orig", item)

        if dry_run:
            prompt = build_cold_prompt(item)
            print(f"\n--- #{i+1}: {item.get('name', orig.get('name'))} ---")
            print(f"Prompt: {prompt[:200]}...")
            results.append({**orig, "draft_message": "[DRY RUN]"})
            continue

        prompt = build_cold_prompt(item if "position" in item else orig)
        draft = call_anthropic(COLD_OUTREACH_SYSTEM, prompt)

        if draft:
            results.append({
                "slug": orig["slug"],
                "name": orig["name"],
                "position": orig["position"],
                "company": orig["company"],
                "firm_type": orig.get("firm_type", ""),
                "function_tag": orig.get("function_tag", ""),
                "seniority": orig.get("seniority", ""),
                "draft_message": draft,
                "knowledge_used": orig.get("knowledge_used", ""),
                "substack_link": orig.get("substack_link"),
            })
            print(f"  [{i+1}/{len(filtered)}] {orig['name']} - done")
        else:
            print(f"  [{i+1}/{len(filtered)}] {orig['name']} - FAILED", file=sys.stderr)

        if not dry_run and (i + 1) % 50 == 0:
            print(f"  Pausing 5s after {i+1} requests...")
            time.sleep(5)

    return results


def render_reengagement_md(drafts):
    """Render re-engagement drafts to markdown."""
    lines = [
        "# Re-engagement Messages (v3 - Style Guide Applied)",
        "",
        f"Generated: {time.strftime('%Y-%m-%d')} | Total: {len(drafts)} drafts | Model: Sonnet 4.6 | Style: outreach-style.md",
        "",
    ]

    # Index table
    lines.append("| # | Name | Position | Company | Days ago | Msgs | Score | Status |")
    lines.append("|---|------|----------|---------|----------|------|-------|--------|")
    for i, d in enumerate(drafts):
        pos = d["position"][:40] if len(d["position"]) > 40 else d["position"]
        lines.append(f"| {i+1} | {d['name']} | {pos} | {d['company']} | {d['days_ago']}d | {d['message_count']} | {d['score']:.0f} | pending |")

    lines.append("")

    # Individual messages
    for i, d in enumerate(drafts):
        lines.append("---")
        lines.append("")
        lines.append(f"## #{i+1}: {d['name']}")
        lines.append("")
        lines.append(f"**{d['position']}** @ {d['company']}")
        lines.append(f"Last message: {d['days_ago']}d ago | {d['message_count']} messages | Score: {d['score']:.0f}")
        if d.get("knowledge_used"):
            lines.append(f"Knowledge: {d['knowledge_used']}")
        if d.get("substack_link"):
            lines.append(f"Substack: {d['substack_link']}")
        lines.append("")
        lines.append("### Draft")
        lines.append("")
        lines.append(d["draft_message"])
        lines.append("")
        lines.append("**Status:** pending")
        lines.append("")

    return "\n".join(lines)


def render_cold_md(drafts):
    """Render cold outreach drafts to markdown."""
    lines = [
        "# Cold Outreach Messages - Never-Contacted Connections",
        "",
        f"Generated: {time.strftime('%Y-%m-%d')} | Total: {len(drafts)} drafts | Model: Sonnet 4.6 | Style: outreach-style.md",
        "",
    ]

    # Index table
    lines.append("| # | Name | Position | Company | Firm Type | Seniority | Status |")
    lines.append("|---|------|----------|---------|-----------|-----------|--------|")
    for i, d in enumerate(drafts):
        pos = d["position"][:40] if len(d["position"]) > 40 else d["position"]
        lines.append(f"| {i+1} | {d['name']} | {pos} | {d['company']} | {d.get('firm_type', '')} | {d.get('seniority', '')} | pending |")

    lines.append("")

    for i, d in enumerate(drafts):
        lines.append("---")
        lines.append("")
        lines.append(f"## #{i+1}: {d['name']}")
        lines.append("")
        lines.append(f"**{d['position']}** @ {d['company']}")
        lines.append(f"{d.get('firm_type', '')} | {d.get('function_tag', '')} | {d.get('seniority', '')}")
        if d.get("knowledge_used"):
            lines.append(f"Knowledge: {d['knowledge_used']}")
        lines.append("")
        lines.append("### Draft")
        lines.append("")
        lines.append(d["draft_message"])
        lines.append("")
        lines.append("**Status:** pending")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Regenerate outreach messages with style guide")
    parser.add_argument("--type", choices=["reengagement", "cold", "all"], required=True)
    parser.add_argument("--limit", type=int, help="Only process first N messages (for testing)")
    parser.add_argument("--dry-run", action="store_true", help="Print prompts without calling API")
    args = parser.parse_args()

    briefs = json.load(open("/tmp/step6-all-briefs.json"))
    print(f"Loaded {len(briefs)} briefs")

    if args.type in ("reengagement", "all"):
        results = process_re_engagement(briefs, limit=args.limit, dry_run=args.dry_run)
        if not args.dry_run and results:
            # Save JSON
            json_path = "/tmp/step7-v3-reengagement.json"
            with open(json_path, "w") as f:
                json.dump(results, f, indent=2)
            print(f"Saved {len(results)} re-engagement drafts to {json_path}")

            # Save markdown
            md_path = os.path.expanduser("~/Desktop/gbrain-reengagement-messages-v3.md")
            with open(md_path, "w") as f:
                f.write(render_reengagement_md(results))
            print(f"Saved markdown to {md_path}")

    if args.type in ("cold", "all"):
        results = process_cold(briefs, limit=args.limit, dry_run=args.dry_run)
        if not args.dry_run and results:
            json_path = "/tmp/step7-v3-cold.json"
            with open(json_path, "w") as f:
                json.dump(results, f, indent=2)
            print(f"Saved {len(results)} cold outreach drafts to {json_path}")

            md_path = os.path.expanduser("~/Desktop/gbrain-cold-outreach-messages-v2.md")
            with open(md_path, "w") as f:
                f.write(render_cold_md(results))
            print(f"Saved markdown to {md_path}")


if __name__ == "__main__":
    main()
