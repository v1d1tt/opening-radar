import os

os.environ.setdefault("USE_TF", "0")

import json
import time

import gradio as gr
import laya

try:
    import spaces

    @spaces.GPU
    def _gpu_probe():
        return True
except ImportError:
    pass

API_KEY = os.environ.get("LAYA_API_KEY", "")
agent = laya.load("convaiinnovations/laya", device="cpu")


def decide(payload: str, key: str) -> str:
    """payload = {"states": [...], "questions": {...}} or {"state": ..., "questions": {...}}"""
    if API_KEY and key != API_KEY:
        return json.dumps({"error": "bad key"})
    req = json.loads(payload)
    t0 = time.time()
    if "states" in req:
        out = agent.predict_batch(req["states"], req["questions"])
        answers = [r["answers"] for r in out]
    else:
        answers = agent.predict(req["state"], req["questions"])["answers"]
    return json.dumps({"answers": answers, "ms": round((time.time() - t0) * 1000)})


with gr.Blocks(title="Laya decision API") as demo:
    gr.Markdown("Laya decision model. Call the `decide` API with a JSON payload of state(s) and questions.")
    payload = gr.Textbox(label="payload")
    key = gr.Textbox(label="key", type="password")
    out = gr.Textbox(label="result")
    gr.Button("Decide").click(decide, [payload, key], out, api_name="decide")

demo.queue(default_concurrency_limit=4).launch()
