# Privacy markers for pages your users may share (Package 2)

When an employee shares a browser tab with your IT technician through the IndiansAssist extension, the page is
mirrored as DOM, not pixels. Every form value is already hidden from the technician, and passwords and card fields
can never be revealed. You can add these markers to your own web applications to hide or block more.

| Marker | Effect in the technician's view | Can the user reveal it? |
|---|---|---|
| `data-ia-sensitive` (attribute on any element) | All text inside the element is replaced by `********` (fixed length, so the length is not disclosed) | Yes, per field or per tab, for at most 60 seconds, only after the user approves the technician's written reason |
| `data-ia-block` (attribute on any element) | The element is never captured; the technician sees an empty box of the same size | No |
| `rr-mask` (class) | Text inside is masked (rrweb's generic marker) | Yes, like `data-ia-sensitive` |
| `rr-block` (class) | Not captured (rrweb's generic marker) | No |

Always hidden without any marker:

- every `<input>`, `<textarea>` and `<select>` value (shown as `*` of the same length);
- `[contenteditable]` text (editors such as mail compose boxes);
- password fields, any field that was ever a password field in the page, and fields with `autocomplete`
  `current-password`, `new-password`, `cc-number`, `cc-csc` or `one-time-code` (never revealable);
- cross-origin frames, `<canvas>`, `<video>` and `<audio>` content (shown as placeholders).

Whole sites can be excluded with the organisation's deny list (the extension policy an org admin sets, `PATCH /api/v1/orgs/current/policy/extension`); sign-in pages of
the major identity providers, Indian net banking and UPI sites and password managers are excluded by default.

Examples:

```html
<div data-ia-sensitive>Account number: 1234 5678 9012</div>
<section data-ia-block>Salary details</section>
```

Source of truth: `docs/specs/phase-b-contracts.md` sections 4.1 and 8.
