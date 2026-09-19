from flowspec.eval import features


def workflow(search_id: str, report_id: str) -> dict:
    return {
        "nodes": [
            {
                "id": search_id,
                "tool": "knowledge.search",
                "arguments": {"query": "产品"},
                "depends_on": [],
            },
            {
                "id": report_id,
                "tool": "report.generate",
                "arguments": {"input_from": search_id},
                "depends_on": [search_id],
            },
        ]
    }


def test_semantic_features_ignore_arbitrary_node_ids():
    assert features(workflow("search", "report")) == features(workflow("lookup_1", "make_report_2"))
