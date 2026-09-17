# The prompt lookup should search on what the prompt is about, not on the prompt

The hook that looks a question up before the turn starts pastes the first stretch of the
typed prompt straight into the search. A four-question, four-hundred-character ramble
embeds near nothing, and because the server ORs the words together, whichever note happens
to share the most common English wins. On a replay of a week of real prompts the right note
came back in the top three once out of seven times.

Send a condensed query instead. Keep the names that actually identify what the person is
working on and put them at the front, then the prompt's own remaining words in order, with
question words, filler and clauses too short to be about anything dropped. Read the whole
prompt rather than its head, so a file name late in a long paste is no longer cut off, and
cap what goes out so the arm stays cheap on a keypress-blocking path. A time, a date, a
hyphenated English word or an abbreviation is prose and is not one of those names. When
condensing leaves nothing at all, fall back to what the arm sends today.

Send those names a second time as their own structured field beside the query, bounded in
both count and length, so a server that understands them can require them; a server that
does not will drop the field and say so, and the hook must ignore that. The same logic runs
in two places, the generated hook script on disk and this package's own code, so ship one
source of truth rather than two copies that can drift, and pin that with a test. Everything
outbound still goes through the existing sanitizer first. Only the prompt arm changes; the
other arms keep the query they send today. Run only the focused test files you touch.
