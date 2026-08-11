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

## 3. The feel: soft, roomy, and it moves when you touch it

Three numbers set the character of the whole app, and all three live in
`themes.ts`:

- **Radius.** The default rung is 10/15/22/30. At 9px a card is a rectangle
  with the corners taken off; at 15px it is an object you could pick up.
- **Space.** `cozy` is a 36px row on a 4/8/12/17/24/34 ladder. The default is
  the density that feels good, not the one that fits most rows on a laptop —
  that is what `compact` is for.
- **Type.** 11/12/13/14.5/16/21/28. The old ladder had body, secondary and meta
  inside one point of each other, which the eye reads as a single flat grey
  size. Each rung needs somewhere to be.

And one more, in `App.css`: **`--press` must be visible.** It was
`translateY(0.5px) scale(0.994)` — below the threshold at which a person
registers that anything happened — and that single number was most of why the
app felt dead. No amount of animation elsewhere substitutes for a control that
gives under the pointer. `scale(0.965)`, and controls lift on hover so the
press has something to undo.

The one springy curve is `--ease-spring`, and it is only ever used on something
*arriving*. A dismissal that bounces is a dismissal you have to watch.

## 3a. The frame: a panel on a window

The app is not two columns sharing an edge. The window is `--app-bg`; the
navigation rail stands directly on it with no fill and no border of its own;
the content is a single rounded panel inset from three sides and lifted with
`--shadow-md`. The macOS traffic lights land on the window above the panel,
which is why no surface reserves room for them any more — `--titlebar` is
redefined inside the panel as its own top gutter.

Consequences a design pass has to respect:

- Anything pinned to the viewport (a drawer, a floating opener) lines up with
  the panel's edges using `--frame-gap`, not with the window's.
- `--bg-raised` is no longer the rail. It means "a column inside the panel that
  is not the panel": the documents and mail lists, the knowledge sources rail,
  the chat tool strip, the settings index, the setup spine.
- A selected nav row takes the panel's own colour, edge and shadow — it is the
  near end of the surface it opens, not a tinted row.

## 3b. One ladder, four rungs, and what each one means

| rung | token | what it is |
| --- | --- | --- |
| 0 | `--app-bg` | the window, behind everything |
| 1 | `--bg` | the panel — the canvas you work on |
| 2 | `--bg-raised` | a column inside the panel: list, rail, index, spine |
| 3 | `--surface-1` | paper on the canvas: a card, a note being read |
| — | `--bg-inset` | a *well* cut into a surface: code, terminal, a field, a segmented track |

A three-column surface is a sentence in this vocabulary. Knowledge reads
**recessed → canvas → paper**: controls you set and stop looking at, the list
you scan, the one thing you actually read. Documents, Mail and Memory say the
same thing the same way. Three identical columns divided by hairlines say
nothing.

## 3c. Selected is a fill — except in a groove

The app's one selected treatment is `--accent-soft` behind and `--text` on top.
The single exception is the segmented control, whose track is a well: a wash
inside a well reads as a coloured hole in it, so the selected segment is a
raised thumb (`--surface-1` + `--shadow-sm`) coming up out of the groove. There
is one segmented control, defined once in App.css over every selector that uses
it. If you find yourself writing a second one, you are writing the bug this
rule exists to prevent.

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
11. Does every column on this surface say which rung of the ladder it is on,
    and is that rung the one its *role* implies?
12. Is this control already defined somewhere else under a different class
    name? Two segmented controls is one too many.
13. Does anything here reserve room for the traffic lights? They are on the
    window now.
14. Do two things in the product share a name (as Connections the link graph
    and Connections the OAuth accounts once did)? Rename one.
15. Is every control at least 24px on both axes? `--row-h` is the stated floor,
    but controls that live inside a line of text cannot be that tall. They get
    the target without the height from the `::before` overlay in `App.css` —
    which only works if no ancestor clips. Where one does, the control has to
    earn the height honestly (`.run-mark`, `.db-repo-tag`).
16. Does anything clip on one axis using `overflow: hidden`? Setting one axis
    to `hidden` promotes the other to `auto`, quietly turning the element into
    a scroll container. `overflow-x: clip` + `overflow-y: visible` is the pair
    that means what it says.
17. When a row of chips runs out of room, does the last one truncate or does it
    get sliced? Chips need `min-width: 0` and room to shrink, or the container
    cuts them mid-pill instead of letting their own ellipsis fire.
18. Does every scroll boundary have an edge on it? The scrollbars are hidden by
    choice, so a hairline is the only thing left telling the reader that a
    column continues past a cut rather than ending badly — and content always
    gets cut mid-word, never politely between rows. This is why the kanban
    column heads and the account row draw one.
19. Does the composer land on the message column? `--msg-gutter` is the avatar
    column plus its gap, and the composer, its hint and its mention popup all
    take it, so the box you type in is exactly the column you read. A control
    that sits *near* the text it belongs to reads as broken in a way that one
    deliberately offset does not.
