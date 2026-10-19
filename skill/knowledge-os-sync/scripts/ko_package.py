#!/usr/bin/env python3
"""Build and pre-check a ko.learning-update package locally (no network).

Usage:
  python ko_package.py new --out draft.json
  python ko_package.py check --file draft.json
  python ko_package.py title-key --title "依赖注入"
"""
import argparse
import json
import re
import secrets
import sys
import time
import unicodedata


def normalize(value):
    return re.sub(r'[^\w\u3400-\u9fff]', '', unicodedata.normalize('NFKC', str(value)).casefold())


def skeleton():
    return {
        'format': 'ko.learning-update',
        'formatVersion': 1,
        'submissionId': 'sub_' + secrets.token_hex(8),
        'sourceType': 'agent_skill',
        'scope': '（写清本次整理范围：哪一段对话、哪些文件、用户授权到哪一步）',
        'agent': {'name': 'workbuddy', 'skill': 'knowledge-os-sync', 'skillVersion': '1.1.0'},
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'fragments': [
            {'title': '（来源名称）', 'kind': 'user_original', 'text': '（用户原文片段，至少 10 字符）'},
        ],
        'items': [
            {
                'key': 'k1',
                'title': '（知识点标题）',
                'aliases': [],
                'kind': 'knowledge',
                'layer': 1,
                'summary': '（一句话说明这个知识点是什么）',
                'concepts': [['（要点）', '（解释）']],
                'tasks': ['（一个可执行的练习）'],
                'mistakes': [],
                'prerequisites': [],
                'understanding': [],
                'openQuestions': [],
                'recommended': [],
            }
        ],
    }


def check(package):
    problems = []
    if package.get('format') != 'ko.learning-update':
        problems.append(('format', '必须是 ko.learning-update'))
    if package.get('formatVersion') != 1:
        problems.append(('formatVersion', '目前只支持 1'))
    if not re.match(r'^[A-Za-z0-9_-]{8,80}$', str(package.get('submissionId', ''))):
        problems.append(('submissionId', '8-80 位字母数字与 -_'))
    if not str(package.get('scope', '')).strip() or '写清本次整理范围' in str(package.get('scope')):
        problems.append(('scope', '必须写明整理范围'))
    fragments = package.get('fragments') or []
    if not fragments:
        problems.append(('fragments', '至少一段来源'))
    for index, fragment in enumerate(fragments):
        if fragment.get('kind') == 'ai_summary':
            if fragment.get('text') and len(fragment['text']) > 50000:
                problems.append(('fragments[%d].text' % index, '超过 50000 字符'))
        elif len(str(fragment.get('text', '')).strip()) < 10:
            problems.append(('fragments[%d].text' % index, '原文至少 10 字符；只有摘要请标 ai_summary'))
    items = package.get('items') or []
    if not items:
        problems.append(('items', '至少一条'))
    if len(items) > 20:
        # 与服务器图校验的上限一致：超了就在这里拦下，别等服务器报 422。
        problems.append(('items', '最多 20 条；请拆成多次提交'))
    keys = [item.get('key') for item in items]
    if len(set(keys)) != len(keys):
        problems.append(('items[].key', '必须唯一'))
    for index, item in enumerate(items):
        if len(str(item.get('key', ''))) > 20:
            # 与服务端 schema 一致：超长会在本地拦下，别等 422。
            problems.append(('items[%d].key' % index, '最多 20 个字符'))
    titles = [normalize(item.get('title', '')) for item in items]
    if len(set(titles)) != len(titles):
        problems.append(('items[].title', '归一化后必须唯一'))
    for index, item in enumerate(items):
        for field in ('level', 'stage', 'mastery', 'verified'):
            if field in item:
                problems.append(('items[%d].%s' % (index, field), '不能由智能体声明'))
        if not str(item.get('summary', '')).strip():
            problems.append(('items[%d].summary' % index, '不能为空'))
        if not item.get('concepts'):
            problems.append(('items[%d].concepts' % index, '至少一个要点'))
        if not item.get('tasks'):
            problems.append(('items[%d].tasks' % index, '至少一个练习'))
        kind = item.get('kind', 'knowledge')
        if kind not in ('knowledge', 'project'):
            problems.append(('items[%d].kind' % index, '只能是 knowledge 或 project'))
        if not isinstance(item.get('layer', 1), int) or not 1 <= item.get('layer', 1) <= 4:
            problems.append(('items[%d].layer' % index, '1-4'))
    return problems


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    new = sub.add_parser('new')
    new.add_argument('--out', required=True)
    chk = sub.add_parser('check')
    chk.add_argument('--file', required=True)
    key = sub.add_parser('title-key')
    key.add_argument('--title', required=True)
    args = parser.parse_args()

    if args.command == 'new':
        with open(args.out, 'w', encoding='utf-8') as handle:
            json.dump(skeleton(), handle, ensure_ascii=False, indent=1)
        print('已生成骨架 %s（未上传）' % args.out)
        return 0
    if args.command == 'title-key':
        print(normalize(args.title))
        return 0
    with open(args.file, encoding='utf-8') as handle:
        package = json.load(handle)
    problems = check(package)
    if problems:
        for path, message in problems:
            print('%-30s %s' % (path, message))
        return 2
    print('校验通过：%d 条来源，%d 条知识点，submissionId=%s' % (
        len(package['fragments']), len(package['items']), package['submissionId']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
