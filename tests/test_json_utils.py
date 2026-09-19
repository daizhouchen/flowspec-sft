from flowspec.json_utils import extract_json


def test_extract_json_uses_first_complete_object():
    assert extract_json('{"value": 1}{"value": 2}') == {"value": 1}


def test_extract_json_repairs_mismatched_node_closer():
    malformed = (
        '{"schema_version":"1.0","nodes":['
        '{"id":"send","retry":{"max_attempts":0}],"when":"ready"}]}'
    )
    result = extract_json(malformed)
    assert result is not None
    assert result["nodes"][0]["when"] == "ready"
