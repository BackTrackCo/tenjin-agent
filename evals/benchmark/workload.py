"""Deterministic assignments from a semantically reviewed workload frame.

The reviewer supplies work-type scope and correlation clusters. This code never
infers eligibility, replaces difficult tasks, or reads model outcomes.
"""
from __future__ import annotations

import hashlib
from typing import Any


def assign(frame: list[dict[str, Any]], *, seed: str, frame_hash: str, per_repository: int = 2) -> dict[str, Any]:
    if not seed or per_repository < 1 or len(frame_hash) != 64:
        raise ValueError("sampling requires a seed, frame digest and positive allocation")
    seen = set()
    rows = []
    for entry in frame:
        required = {"id", "repository", "stratum", "cluster", "in_scope"}
        if set(entry) != required or not all(isinstance(entry[key], str) and entry[key] for key in required - {"in_scope"}) or not isinstance(entry['in_scope'], bool):
            raise ValueError("workload rows require explicit reviewed identity, stratum, cluster and scope")
        if entry['id'] in seen:
            raise ValueError("duplicate workload task")
        seen.add(entry['id'])
        rank = hashlib.sha256('\n'.join((seed, frame_hash, entry['stratum'], entry['id'])).encode()).hexdigest()
        rows.append({**entry, 'rank': rank})
    selected = []
    pilot_clusters = set()
    counts = {}
    for repository in sorted({row['repository'] for row in rows}):
        scoped = sorted((row for row in rows if row['repository'] == repository and row['in_scope']), key=lambda row: (row['rank'], row['id']))
        counts[repository] = len(scoped)
        chosen = 0
        for row in scoped:
            if (repository, row['cluster']) in pilot_clusters:
                continue
            selected.append(row['id'])
            pilot_clusters.add((repository, row['cluster']))
            chosen += 1
            if chosen == per_repository:
                break
        if chosen != per_repository:
            raise ValueError("repository has too few independent clusters for the frozen allocation")
    for row in rows:
        row['assignment'] = ('out-of-scope' if not row['in_scope'] else 'pilot-proof-required' if row['id'] in selected else 'pilot-cluster-reserve' if (row['repository'],row['cluster']) in pilot_clusters else 'locked-reserve')
    return {'schema':'bench1.workload-assignment.v1', 'seed':seed, 'frame_sha256':frame_hash,
            'allocation_per_repository':per_repository, 'population_counts':counts,
            'selected':selected, 'rows':sorted(rows,key=lambda row:row['id']),
            'model_admission':False}
