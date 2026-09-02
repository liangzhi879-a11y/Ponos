# 外部程序注册为标准模块的最小示例（cli-bridge 运行时）：
# stdin 每行 JSON {id, method, params} → stdout 响应 {id, result:{ok,...}}；无 id 消息忽略。
# 纯标准库，无第三方依赖。
import json
import sys
import time


def handle(method, params):
    if method == "echo.echo":
        return {"ok": True, "text": params.get("text", "")}
    if method == "echo.time":
        return {"ok": True, "time": int(time.time())}
    if method == "echo.add":
        return {"ok": True, "sum": int(params.get("a", 0)) + int(params.get("b", 0))}
    return {"ok": False, "error": "METHOD_NOT_FOUND"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        if req.get("id") is None:
            continue
        res = handle(req.get("method"), req.get("params") or {})
        out = {"ok": True, "result": res} if res.get("ok") else {"ok": False, "error": res.get("error")}
        sys.stdout.write(json.dumps({"id": req["id"], "result": out}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
