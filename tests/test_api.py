from fastapi.testclient import TestClient

from flowspec.api import app

client = TestClient(app)


def test_tools_and_compile_api():
    tools = client.get("/api/tools")
    assert tools.status_code == 200
    assert len(tools.json()) == 18
    response = client.post("/api/compile", json={"instruction": "搜索产品知识并生成报告。"})
    assert response.status_code == 200
    assert response.json()["validation"]["valid"]

