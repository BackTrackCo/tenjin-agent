import pytest
from evals.benchmark.workload import assign


def frame():
    return [{'id':f'{repo}-{n}','repository':repo,'stratum':repo+'/runtime','cluster':str(n//2),'in_scope':n!=6} for repo in ('a','b') for n in range(7)]


def test_assignment_is_order_invariant_and_separates_whole_clusters():
    result=assign(frame(),seed='frozen',frame_hash='a'*64)
    assert result==assign(list(reversed(frame())),seed='frozen',frame_hash='a'*64)
    assert len(result['selected'])==4 and result['model_admission'] is False
    pilot={(r['repository'],r['cluster']) for r in result['rows'] if r['id'] in result['selected']}
    assert len(pilot)==4
    assert all((r['repository'],r['cluster']) not in pilot for r in result['rows'] if r['assignment']=='locked-reserve')
    assert result['population_counts']=={'a':6,'b':6}


def test_outcomes_and_duplicate_tasks_cannot_influence_assignment():
    rows=frame(); rows[0]['savings']=1
    with pytest.raises(ValueError): assign(rows,seed='frozen',frame_hash='a'*64)
    with pytest.raises(ValueError,match='duplicate'): assign(frame()+[frame()[0]],seed='frozen',frame_hash='a'*64)


def test_insufficient_clusters_refuse_instead_of_repeating_one():
    rows=frame()
    for row in rows: row['cluster']='same'
    with pytest.raises(ValueError,match='few independent'): assign(rows,seed='frozen',frame_hash='a'*64)
