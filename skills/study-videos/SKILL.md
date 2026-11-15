---
name: study-videos
description: Build a continuous YouTube "video run" for studying a course topic. Works out what will be tested (from Brightspace, uploaded slides, a syllabus or the user's topic list), finds YouTube videos, checks their transcripts to pick only the relevant minutes, and builds a local page that plays the chosen segments back to back with a note under each (and practice questions between topics, if the user asks). Use when the user asks for videos, a video playlist, a watch list, or "the parts of the video I should watch" for a course, test, quiz or topic.
---

# Study videos

Produces one page per study goal: the chosen minutes of several YouTube videos playing back to back, and a note under each saying how it relates to the course. Practice questions between topics are optional: add them only if the user asks.

Tools come from the `youtube-study` MCP server: `search_videos`, `get_video_info`, `get_transcript`, `build_video_page`, `open_video_page`. Course material comes from any course MCP server the user has connected (the kit's `brightspace` server or their own), or from files they share.

Videos teach mechanics. The course's own notation, worked examples and proofs come from its slides, so always say which parts no video covers.

## 1. Work out what will be tested

Use whatever the user has, in this order:

1. **A course MCP server, if one is connected.** Use whichever school or LMS server the user already has (their own Brightspace or onQ server, Canvas, Moodle, Blackboard and so on), with its own tool names. The kit's `brightspace` server is only one option. With it: `list_courses`, then `get_course_content` for the module and file list, `get_topic_content` to read slides (it saves PDFs locally), and `list_announcements` for the test date and scope. Look for a practice test or review sheet.
2. **Files the user gives you:** slides, a syllabus, a review sheet, a practice test.
3. **Nothing else:** ask the user for the topic list, or what the test covers.

If a practice test exists, it is the best guide to scope. Do not show its answers.

List the topics with the instructor's specifics for each: formulas and notation, sign conventions, which version of a proof or method is used, and the worked examples. These decide which video sections fit.

## 2. Find candidate videos

- `search_videos` for each topic. Prefer short worked-example videos (5 to 20 minutes) in clear English. One channel's series for a group of sub-topics keeps notation consistent.
- `get_video_info` gives length, chapters and caption availability without the transcript.

## 3. Verify with transcripts, then pick segments

- `get_transcript` with `start`/`end` reads only the part you need; `chunk_seconds: 40` keeps it compact.
- **Timestamps come only from the transcript or the creator's chapter list.** Never guess, and never trust timestamps from another AI's summary.
- Keep only sections that teach something the student needs and has not already seen. Cut intros, recaps of earlier videos, repeated material, sponsor reads and code walkthroughs unless code is tested.
- Compare with the course: different constants, conventions or proof approach go in the segment's `note`. If a video teaches a method the course does not use, drop it.
- No captions at all means the video cannot be verified. Say so, or pick another.

## 4. Build

Call `build_video_page` with a `title`, a short `name`, and `segments` in study order:

```json
{"topic": "Double hashing", "video": "Dzm9c1P0_Nw", "start": "2:16", "end": "5:21",
 "title": "Two hash functions",
 "note": "How this differs from the course, in one or two sentences.",
 "check": "Only if the user asked for practice questions, on the LAST segment of a topic: an exercise or 2-3 quiz questions from the course material. No answers."}
```

- Times are `m:ss`, `h:mm:ss` or seconds.
- `check` is optional. Leave it out unless the user asks for practice questions; the run then plays straight through. When it is set, the page pauses there.
- Reusing a `name` replaces that run. The spec is saved next to the page as JSON.

## 5. Report

- A table: topic, video, time range, and why it is in.
- What no video covers, which is slides-only work.
- Total time at 1x and 1.5x (the build result gives both).
- How to open it later: ask "open my <name> video run", which calls `open_video_page`.

## Pitfalls

- **Error 153** in the player means the page was opened as a file. It must come from the local server, which `build_video_page` and `open_video_page` start.
- **HTTP 429** from YouTube means too many caption requests. Fetch one video at a time and wait a minute if it happens.
