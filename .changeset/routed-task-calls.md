---
'tenjin-cli': patch
---

Your agent can now read and run a routed task. `request({task})` shows what a task takes, returns and costs, free. `request({task, input})` checks the input, then checks one quote for the Tenjin routing fee and the provider's allowed maximum together, against your spend limits, before either is paid. The result has the task's own `output` shape, whichever provider ran it, and a receipt with both payments. A provider that refuses, or whose live price is over the approved cap, gives way to a fallback before anything is signed. A reply lost after a payment stops the run with a receipt, and a second attempt needs your yes. Offers are free now: they use no wallet and never wait behind another payment. A router without this feature is still served as before. `tenjin request` does the same from a script, and `tenjin doctor` checks the router's answer.
