# Sanitizing a question to scaffolding is worse than not sanitizing it

Owner ruling, and it reverses the current default: for anything that becomes a search
query or captured knowledge, availability beats sanitization. File paths, host names, file
basenames and commit SHAs are the best search keys we have, and the server now has a lane
that ranks on exactly those. Today the sanitizer blanks all of them on the way out, which
leaves a question made of nothing but connective tissue, and that scaffolding still gets
sent to a production search where it matches whatever is popular.

Add a narrower sanitizing mode and route every search-bound and knowledge-bound arm through
it: the typed-prompt arm, the subagent-dispatch arm, the fetch arm, the churn arm, the
failure arm and findings capture. In the narrow mode only credentials, control bytes and
e-mail addresses come out; paths, hosts, basenames, environment-variable names and
SHA-shaped tokens ship whole. The existing full mode must stay byte-identical for every
caller that does not ask for the new one. Watch the entropy rule in the narrow mode, since
a commit SHA looks like a high-entropy token and must not be mistaken for a secret, while
mixed-case and base64-shaped keys still have to be caught in both modes. There is also a
live bug to fix while you are here: the host rule is unanchored, so a file basename whose
extension happens to spell a top-level domain is blanked to nothing and silences the arm
that reported it.

The residue threshold that exists today was a workaround for the gutting, so delete it and
guard on an empty question instead. One arm assembles its query out of more than one
piece of text, so make sure the guard reads the assembled result and not just the part
that came from the person. Existing installs keep
their old generated scripts until the installer is re-run, and the fingerprints the failure
arm stores are content-free, so they do not move. Run only the focused test files you touch.
