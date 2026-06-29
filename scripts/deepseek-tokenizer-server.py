"""DeepSeek tokenizer JSON-line server.

Usage: python scripts/deepseek-tokenizer-server.py <tokenizer_dir>

Reads JSON objects from stdin, one per line: {"id": 1, "text": "..."}
Writes JSON responses to stdout: {"id": 1, "tokens": 42}
Sends {"ready": true} on startup.
"""

import sys
import json
import transformers

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: deepseek-tokenizer-server.py <tokenizer_dir>"}), flush=True)
        sys.exit(1)

    tokenizer_dir = sys.argv[1]
    tokenizer = transformers.AutoTokenizer.from_pretrained(tokenizer_dir, trust_remote_code=True)
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), flush=True)
            continue

        request_id = request.get("id")
        text = request.get("text", "")
        if not isinstance(text, str):
            print(json.dumps({"id": request_id, "error": "text must be a string"}), flush=True)
            continue

        try:
            token_ids = tokenizer.encode(text)
            print(json.dumps({"id": request_id, "tokens": len(token_ids)}), flush=True)
        except Exception as e:
            print(json.dumps({"id": request_id, "error": str(e)}), flush=True)

if __name__ == "__main__":
    main()
