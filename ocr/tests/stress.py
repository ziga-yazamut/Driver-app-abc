"""Large random run on synthetic check photos.

usage: python tests/stress.py N [severity] [seed_offset]
Prints: correct / correct+flagged / wrong+flagged / wrong (silent). Silent wrong must be 0.
"""
import collections
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_ocr as c  # noqa: E402
import synth  # noqa: E402


def main(n=100, sev=1.0, off=0):
    T = c.Templates()
    stats, reasons = collections.Counter(), collections.Counter()
    t0 = time.time()
    for i in range(n):
        rng = random.Random(1000 + off + i)
        sp = synth.random_spec(rng)
        r = c.analyze(synth.photograph(synth.render(sp, rng), rng, sev), templates=T)
        ok = (r["check_no"], r["bank"], r["branch_field"], r["account"], r["drawer"]["id"]) == \
             (sp.check_no, sp.bank, sp.branch_field, sp.account, sp.drawer_id)
        stats[("correct" if ok else "wrong") + ("+flagged" if r["needs_review"] else "")] += 1
        if not ok and not r["needs_review"]:
            print("SILENT WRONG", i, sp, r["sources"], r["drawer"]["id"], flush=True)
        for x in r["reasons"]:
            reasons[x.split(":")[0]] += 1
    print(n, sev, dict(stats), round((time.time() - t0) / n, 2), "s/check")
    print(reasons.most_common())
    return stats


if __name__ == "__main__":
    a = sys.argv[1:]
    main(int(a[0]) if a else 100, float(a[1]) if len(a) > 1 else 1.0, int(a[2]) if len(a) > 2 else 0)
