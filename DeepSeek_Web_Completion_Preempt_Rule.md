# DeepSeek Web Completion — `preempt` Rule

This is an explicit implementation rule for the completion protocol documents.

## Established request field

The DeepSeek Web completion request contains:

```json
"preempt": false
```

## Current implementation rule

Keep `preempt` **fixed at `false`**.

Do not expose it as a dynamic option, infer alternate semantics, or change it to `true` based on assumptions.

The semantics of `preempt: true` are **NOT ESTABLISHED** by the checked-in HAR captures.

Only make `preempt` dynamic if a future checked-in HAR directly demonstrates that the DeepSeek Web client sets `preempt` dynamically.

Therefore the current conforming request is:

```json
{
  "preempt": false
}
```

This rule applies to both:

- `DeepSeek_Web_Completion_Protocol_v1.0.md`
- `DeepSeek_Web_Completion_Protocol_v2.3.md`
