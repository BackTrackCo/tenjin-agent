---
'tenjin-cli': patch
---

Prices come only from each offer's spec, never from the wording of its line. A spec may also set its own call deadline (`timeoutS`) and file size limit (`maxBytes`, not yet applied to a long-running job's polled result); without them the previous limits apply.
