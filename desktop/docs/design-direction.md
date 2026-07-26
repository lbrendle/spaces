# Design direction — a work tool, not a document tool

The reference point is Asana, not Notion. Both are well made; they are built on
opposite premises, and Spaces has been drifting toward the wrong one.

**Notion's premise:** the page is the unit. Structure is something you build.
Affordances stay hidden until hover so the canvas reads as calm. Prose is the
content. You look at a Notion page to *read* it.

**Asana's premise:** the object is the unit — a task, a person, a date, a
status. Structure is given, and opinionated. Affordances are visible because
you are here to act. Prose is supporting detail. You look at an Asana list to
*scan* it and then do something.

Spaces is a work tool. Everything below follows from that.

---

## 1. The object comes first, prose second

A task is not a document that happens to have a status. Its title, assignee,
status and due date are the content; the description supports them.

- List rows lead with the object and its state. Description is a single clamped
  line at most, or absent.
- Detail panels put metadata **above** the body, not below it.
- Never make someone open a row to learn something the row could have shown.

## 2. Scan-ability beats breathing room

Whitespace is not the goal; *rhythm* is. A list of thirty tasks should be
readable in one downward sweep.

- Fixed row height per surface (`--row-h`), so the eye can track columns.
- Metadata aligns into columns — assignee, status, due, count. Ragged metadata
  is the single biggest scan-ability failure.
- `font-variant-numeric: tabular-nums` on every number, date and count.
- Comfortable ≠ sparse. Default density should show more rows than it does now.
- Cards are for boards. Everywhere else, a list is a list.

## 3. Colour is semantic, not decorative

The accent is for the primary action and the current selection. Everything else
that is coloured must *mean* something.

- Status: to-do / in progress / done / blocked each read at a glance.
- Urgency: overdue, due today, due this week. Overdue is the only place red is
  used for a task.
- Identity: an agent or person's colour is theirs consistently, everywhere.
- If a colour cannot answer "what does this tell me?", it should be
  `--text-dim`.

## 4. Every surface has the same grammar

Learn it once, apply it everywhere. The frame is:

```
Title            [view switcher]        [search] [filter] [sort]  [Primary ▸]
──────────────────────────────────────────────────────────────────────────────
content
```

- Primary action is top-right, always, and always looks like a button.
- Filters persist per surface and show an active count when set.
- The view switcher (list / board / calendar, where several apply) is the same
  control in the same place.
- No surface invents its own header.

## 5. Affordances are visible

Hover-to-reveal is a Notion habit. It hides the product from anyone who has not
already learned it, and it is invisible to keyboard users entirely.

- Row actions are present at low contrast and strengthen on hover — not absent
  and then appearing.
- Anything reachable by hover is reachable by focus, and looks the same.
- A button looks like a button. A link looks like a link.

## 6. Prose surfaces are the exception, and stay that way

Knowledge, Documents and the memory body **are** reading surfaces. There,
generous measure (~68ch), comfortable line height and calm are correct.

The rule: reading comfort applies to the *body of a document*. It does not
apply to the list of documents, the sidebar, the toolbar or anything else. A
document tool inside a work tool, clearly bounded.

## 7. Motion confirms, it does not perform

- 120ms acknowledgement, 200ms transition, nothing over 300ms.
- `transform` and `opacity` only.
- Silent under `prefers-reduced-motion`.
- Nothing loops. Nothing bounces. A spinner is the only thing that repeats.

---

## Checkable rules

An agent doing a design pass should be able to answer yes to all of these:

1. Can I identify every row's status and owner without opening it?
2. Do the numbers line up in a column?
3. Is the primary action top-right and does it look like a button?
4. Is every coloured thing colour-coded for a reason I can state?
5. Are row actions visible (dimmed) rather than hidden until hover?
6. Does the surface use the same header grammar as every other surface?
7. On a light theme, is the focus ring visible on every surface?
8. With `prefers-reduced-motion`, does anything still move?
9. Does a 30-row list fit on a laptop screen without scrolling past a header
   that could have been smaller?
10. If this screen were a Notion page, what would I have to delete to make it a
    work tool? Delete that.
