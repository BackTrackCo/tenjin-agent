# Long pieces are clearing the semantic gate on one lucky passage

A piece's semantic score is the best of its chunks, and every gate that reads a semantic
number reads that one. The maximum over N chunks rises with N by construction, so a
twenty-chunk piece gets twenty draws at clearing a fixed threshold where a two-chunk piece
gets two. The result is a long generic piece sitting at rank one on queries a short focused
piece answers better, and clearing the confident bar while doing it.

Make the gates read a length-aware number instead: the mean of a piece's best three chunk
similarities, or all of them when it has fewer. Ordering keeps the maximum, because that is
what ranks, and the entry filter on the semantic leg keeps it too. Move every gate that
judges how good a match is onto the new number, and leave alone the field that records
which rows the semantic leg's own window carried, since that is a fact about what the scan
returned and telemetry counts it. Carry the piece's chunk count along for the feature
logging work that follows this. The thresholds do not move; this is deliberately not a
chunk-count correction of the score, which would shift the whole scale and make "thresholds
unchanged" false.

Compute it exactly rather than from whatever the semantic beam happened to carry. The beam
holds only some of a long piece's chunks, and the ones it left behind are further away than
its worst, so a beam-based mean would overestimate for exactly the pieces this targets. It
runs after fusion over a bounded number of rows, so it is one added indexed round trip on
the fused path. Neither the new number nor the chunk count may reach a caller: they are
derived from paid bodies and sit behind the same boundary the raw similarity does. Also fix
a second, unrelated thing while you are in here: the corpus size that scales the keyword
leg's ordering boosts counts every row in the table rather than only the rows a search could
return, and it should apply the same visibility rule every retrieval leg applies. Align the
offline recall evaluation with whatever the production path now scores. Run only the focused
test files you touch; the integration lane needs Docker.
