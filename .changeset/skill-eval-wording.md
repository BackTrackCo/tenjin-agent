---
'tenjin-cli': patch
---

Four wording fixes to the shipped skills, from the first eval baseline. The
search skill now says what to do when the lookup gates fail (do the task itself)
and to say what the available work does cover when declining a near match. The
publish skill sharpens the terse `questionsAnswered` register to a verbatim error
string or symptom line rather than a bare topic label, and makes the
no-rephrasings rule imperative: every entry must ask something no other entry
asks.
