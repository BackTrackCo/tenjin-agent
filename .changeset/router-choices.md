---
'tenjin-cli': minor
---

A line can now offer a choice of services for one step, such as several
image models. The CLI sends `choices` in `accepts`, and the hook keeps the
offer's choice set beside every option's spec. `request({id, choice, input})`
runs the option the user picked as its own offer, under its own id, exactly
as `request({id: option.id, input})` would. `choice: "all"` runs every option
side by side, each paid once straight to its own provider, after one check
that the whole set fits the spend policy (each payment within `maxAutoSpend`,
the total inside `sessionBudget`); a set that does not fit returns
`needs_approval` with nothing signed. The result lists each option with its
status, cost and saved file under `~/.tenjin/downloads/`, so the agent can
open the images and help the user pick. An option already paid is not paid
again. Which options a set holds is the server's data, so a new set needs no
CLI release.
