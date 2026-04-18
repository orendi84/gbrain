#!/usr/bin/env python3
"""
Add LinkedIn profile links to message draft markdown files.
Reads profile URLs from linkedin-brain person files and patches the draft JSONs + markdowns.

Usage:
  python3 add-profile-links.py
"""

import json
import os
import re
import time
from pathlib import Path

PEOPLE_DIR = Path.home() / "linkedin-brain" / "people"
DESKTOP = Path.home() / "Desktop"


def build_profile_lookup():
    """Build slug -> profile_url mapping from linkedin-brain person files."""
    lookup = {}
    for f in PEOPLE_DIR.glob("*.md"):
        slug = f"people/{f.stem}"
        with open(f) as fh:
            for line in fh:
                if line.startswith("Profile: "):
                    url = line.strip().replace("Profile: ", "")
                    lookup[slug] = url
                    break
    print(f"Built profile lookup: {len(lookup)} URLs")
    return lookup


def patch_reengagement(lookup):
    """Patch re-engagement drafts with profile links."""
    json_path = "/tmp/step7-v3-reengagement.json"
    if not os.path.exists(json_path):
        print("No re-engagement JSON found, skipping")
        return

    drafts = json.load(open(json_path))
    matched = 0
    for d in drafts:
        url = lookup.get(d["slug"])
        if url:
            d["profile_url"] = url
            matched += 1

    print(f"Re-engagement: {matched}/{len(drafts)} matched with profile URLs")

    # Save updated JSON
    with open(json_path, "w") as f:
        json.dump(drafts, f, indent=2)

    # Render markdown
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
        name_cell = f"[{d['name']}]({d['profile_url']})" if d.get("profile_url") else d["name"]
        lines.append(f"| {i+1} | {name_cell} | {pos} | {d['company']} | {d['days_ago']}d | {d['message_count']} | {d['score']:.0f} | pending |")

    lines.append("")

    for i, d in enumerate(drafts):
        lines.append("---")
        lines.append("")
        name_header = f"[{d['name']}]({d['profile_url']})" if d.get("profile_url") else d["name"]
        lines.append(f"## #{i+1}: {name_header}")
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

    md_path = DESKTOP / "gbrain-reengagement-messages-v3.md"
    with open(md_path, "w") as f:
        f.write("\n".join(lines))
    print(f"Saved: {md_path}")


def patch_cold(lookup):
    """Patch cold outreach drafts with profile links."""
    json_path = "/tmp/step7-v3-cold.json"
    if not os.path.exists(json_path):
        print("No cold outreach JSON found, skipping")
        return

    drafts = json.load(open(json_path))
    matched = 0
    for d in drafts:
        url = lookup.get(d["slug"])
        if url:
            d["profile_url"] = url
            matched += 1

    print(f"Cold outreach: {matched}/{len(drafts)} matched with profile URLs")

    with open(json_path, "w") as f:
        json.dump(drafts, f, indent=2)

    lines = [
        "# Cold Outreach Messages - Never-Contacted Connections",
        "",
        f"Generated: {time.strftime('%Y-%m-%d')} | Total: {len(drafts)} drafts | Model: Sonnet 4.6 | Style: outreach-style.md",
        "",
    ]

    lines.append("| # | Name | Position | Company | Firm Type | Seniority | Status |")
    lines.append("|---|------|----------|---------|-----------|-----------|--------|")
    for i, d in enumerate(drafts):
        pos = d["position"][:40] if len(d["position"]) > 40 else d["position"]
        name_cell = f"[{d['name']}]({d['profile_url']})" if d.get("profile_url") else d["name"]
        lines.append(f"| {i+1} | {name_cell} | {pos} | {d['company']} | {d.get('firm_type', '')} | {d.get('seniority', '')} | pending |")

    lines.append("")

    for i, d in enumerate(drafts):
        lines.append("---")
        lines.append("")
        name_header = f"[{d['name']}]({d['profile_url']})" if d.get("profile_url") else d["name"]
        lines.append(f"## #{i+1}: {name_header}")
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

    md_path = DESKTOP / "gbrain-cold-outreach-messages-v2.md"
    with open(md_path, "w") as f:
        f.write("\n".join(lines))
    print(f"Saved: {md_path}")


if __name__ == "__main__":
    lookup = build_profile_lookup()
    patch_reengagement(lookup)
    patch_cold(lookup)
    print("Done!")
