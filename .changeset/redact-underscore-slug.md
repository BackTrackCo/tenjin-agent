---
'tenjin-cli': patch
---

A paid read of a Reddit link no longer stops at "the query carries a credential-shaped value". The URL path check took an underscore slug such as `/report_on_the_rustnl_2024_unconference/` for a token and sent nothing. A path segment with two whole underscore-joined words of 3 or more letters each now passes, like a hyphenated article slug already did. A token with an underscore prefix (`live_abcD3f...`) still masks, since the letters after its underscore run into digits.
