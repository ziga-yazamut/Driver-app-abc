import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import check_ocr as c  # noqa: E402


def test_israeli_id():
    assert c.israeli_id_valid("123456782")
    assert not c.israeli_id_valid("123456789")


def test_templates_loaded():
    assert len(c.Templates().labels) > 0
