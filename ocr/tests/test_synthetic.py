"""בדיקות על שיקים סינתטיים (רצות גם ב-CI, בלי צילומים אמיתיים).

הכלל: תוצאה שגויה בלי needs_review=True היא כישלון.
"""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_ocr as c  # noqa: E402
import synth  # noqa: E402

T = c.Templates()


def fields(r):
    return (r["check_no"], r["bank"], r["branch_field"], r["account"], r["drawer"]["id"])


def truth(sp):
    return (sp.check_no, sp.bank, sp.branch_field, sp.account, sp.drawer_id)


@pytest.mark.parametrize("seed", range(20))
def test_random_checks_never_silently_wrong(seed):
    rng = random.Random(seed)
    sp = synth.random_spec(rng)
    r = c.analyze(synth.photograph(synth.render(sp, rng), rng), templates=T)
    assert fields(r) == truth(sp) or r["needs_review"], (sp, r["sources"])


def test_random_checks_mostly_read_without_review():
    ok = 0
    for seed in range(100, 115):
        rng = random.Random(seed)
        sp = synth.random_spec(rng)
        r = c.analyze(synth.photograph(synth.render(sp, rng), rng), templates=T)
        ok += fields(r) == truth(sp) and not r["needs_review"]
    assert ok >= 12, f"רק {ok}/15 נקראו בלי צורך בבדיקה"


@pytest.mark.parametrize("seed", range(8))
def test_harsh_photos_never_silently_wrong(seed):
    rng = random.Random(900 + seed)
    sp = synth.random_spec(rng)
    r = c.analyze(synth.photograph(synth.render(sp, rng), rng, severity=1.8), templates=T)
    assert fields(r) == truth(sp) or r["needs_review"], (sp, r["sources"])


def test_unknown_digit_8_is_flagged():
    rng = random.Random(7)
    sp = synth.random_spec(rng)
    sp.account = "12834567"
    r = c.analyze(synth.render(sp, rng), templates=T)
    assert r["needs_review"]


def test_printed_line_disagrees_with_micr():
    rng = random.Random(8)
    sp = synth.random_spec(rng)
    wrong = str((int(sp.check_no[-1]) + 1) % 10).replace("8", "9")
    sp.printed_override = f"{sp.check_no[:-1]}{wrong} {sp.bank} {sp.branch_field} {sp.account}"
    r = c.analyze(synth.render(sp, rng), templates=T)
    assert r["needs_review"]
    assert not r["checks"]["micr_matches_printed"]


def test_missing_printed_line_is_flagged():
    rng = random.Random(9)
    sp = synth.random_spec(rng)
    sp.printed_line = False
    r = c.analyze(synth.render(sp, rng), templates=T)
    assert r["needs_review"]
    assert r["check_no"] == sp.check_no   # עדיין נקרא מה-MICR


def test_invalid_drawer_id_is_flagged():
    rng = random.Random(10)
    sp = synth.random_spec(rng)
    sp.drawer_id = sp.drawer_id[:-1] + str((int(sp.drawer_id[-1]) + 1) % 10)
    r = c.analyze(synth.render(sp, rng), templates=T)
    assert r["needs_review"]
    assert not r["drawer"]["id_valid"]


def test_unknown_bank_is_flagged():
    rng = random.Random(11)
    sp = synth.random_spec(rng, bank="99")
    r = c.analyze(synth.render(sp, rng), templates=T)
    assert r["needs_review"]
    assert not r["checks"]["bank_known"]


def test_branch_list_check():
    rng = random.Random(12)
    sp = synth.random_spec(rng, bank="10")
    img = synth.render(sp, rng)
    r = c.analyze(img, templates=T, branches={("10", sp.branch)})
    assert r["checks"]["branch_known"]
    r = c.analyze(img, templates=T, branches={("10", "000")})
    assert not r["checks"]["branch_known"] and r["needs_review"]


def test_no_check_in_photo():
    import numpy as np
    img = np.full((1200, 900, 3), 40, np.uint8)
    r = c.analyze(img, templates=T)
    assert r["needs_review"]
    assert r["check_no"] is None


def test_learn_adds_templates(tmp_path):
    rng = random.Random(13)
    sp = synth.random_spec(rng)
    t = c.Templates(str(tmp_path / "t.npz"))
    n = c.learn(synth.render(sp, rng), [sp.check_no, sp.bank, sp.branch_field, sp.account], t)
    assert n == len(sp.check_no + sp.bank + sp.branch_field + sp.account) + 5
    assert os.path.exists(tmp_path / "t.npz")
