#!/bin/bash
# 任务完成通知脚本（Claude Code hooks 协议）
# 环境变量由 hooks 运行时注入：
#   CLAUDE_NOTIFICATION_MESSAGE - Claude 的消息内容
#   CLAUDE_PROJECT_DIR          - 项目目录
#   CLAUDE_HOOK_POINT           - 触发的事件名（Stop / Notification）

# 钉钉机器人示例
DINGTALK_TOKEN="your-dingtalk-robot-token"
MESSAGE="✅ Agent 任务完成: ${CLAUDE_NOTIFICATION_MESSAGE:-任务结束}"

curl -s -X POST "https://oapi.dingtalk.com/robot/send?access_token=${DINGTALK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"${MESSAGE}\"}}"

# 或者飞书机器人
# FEISHU_TOKEN="your-feishu-robot-token"
# curl -s -X POST "https://open.feishu.cn/open-apis/bot/v2/hook/${FEISHU_TOKEN}" \
#   -H "Content-Type: application/json" \
#   -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"${MESSAGE}\"}}"

echo "通知已发送: ${MESSAGE}"
