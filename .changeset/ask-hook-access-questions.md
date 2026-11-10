---
'tenjin-cli': patch
---

Tenjin no longer stops your agent from asking you a question. Before, a question could be held back once with a paid lookup in its place, even when the question had nothing to do with that lookup. Now only a question that asks you for an API key, an access token, credentials, an account, a sign-up, a subscription or a paid plan can get a suggestion, and the suggestion is added beside the question, which you still see. Other questions pass untouched.
