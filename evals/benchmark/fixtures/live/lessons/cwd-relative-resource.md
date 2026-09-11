# A path with no root is read against the caller's working directory, not against the file that names it

A relative path handed to `fs` is resolved against `process.cwd()`, which belongs to whoever started the process. A module that names a file beside itself with a bare relative path is therefore correct only while the process happens to start in the directory that path was written against, and a caller that starts it anywhere else gets `ENOENT` on a path that plainly exists.

This is the failure that clears itself when you reach for it. Run the same command by hand from the project and it works, print the path and it is the path you meant, list the directory and the file is there. The one thing that separates the two runs is not in either of them: it is the working directory the caller chose, which nothing in the output states and nothing in the module can see.

So read the caller rather than the callee. What the caller sets, an explicit `cwd`, a service directory, a scheduler's own root, is the whole of the difference, and the size of the problem is every relative path the process opens, not the one that failed first.

A path that must mean a file beside the module has to be built from the module's own location, and the module's location is the only thing that is invariant under the caller's choice. Which figures the run expects still come only from a run.
