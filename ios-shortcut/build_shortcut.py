#!/usr/bin/env python3
"""Build the unsigned Rednote Saver shortcut plist.

The generated workflow intentionally uses only built-in Shortcuts actions. It
reads a copied Xiaohongshu share message from the clipboard, so no companion
application or share-sheet integration is required.
"""

from __future__ import annotations

import plistlib
import sys
import uuid
from pathlib import Path


def new_uuid() -> str:
    return str(uuid.uuid4()).upper()


def action_output(action_uuid: str, output_name: str) -> dict:
    return {
        "Value": {
            "OutputName": output_name,
            "OutputUUID": action_uuid,
            "Type": "ActionOutput",
        },
        "WFSerializationType": "WFTextTokenAttachment",
    }


def text_token_output(action_uuid: str, output_name: str) -> dict:
    """Embed an action output inside a text field such as WFURL."""
    return {
        "Value": {
            "attachmentsByRange": {
                "{0, 1}": {
                    "OutputName": output_name,
                    "OutputUUID": action_uuid,
                    "Type": "ActionOutput",
                }
            },
            "string": "\ufffc",
        },
        "WFSerializationType": "WFTextTokenString",
    }


def text_token_variable(variable_name: str) -> dict:
    """Embed a named Shortcuts variable inside a text field."""
    return {
        "Value": {
            "attachmentsByRange": {
                "{0, 1}": {
                    "Type": "Variable",
                    "VariableName": variable_name,
                }
            },
            "string": "\ufffc",
        },
        "WFSerializationType": "WFTextTokenString",
    }


def extension_input() -> dict:
    return {
        "Value": {"Type": "ExtensionInput"},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def repeat_item() -> dict:
    return {
        "Value": {"Type": "Variable", "VariableName": "Repeat Item"},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def named_variable(variable_name: str) -> dict:
    return {
        "Value": {"Type": "Variable", "VariableName": variable_name},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def ask_each_time() -> dict:
    return {
        "Value": {"Type": "Ask"},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def text_token_repeat_item() -> dict:
    return {
        "Value": {
            "attachmentsByRange": {
                "{0, 1}": {"Type": "Variable", "VariableName": "Repeat Item"}
            },
            "string": "\ufffc",
        },
        "WFSerializationType": "WFTextTokenString",
    }


class WorkflowBuilder:
    def __init__(self) -> None:
        self.actions: list[dict] = []

    def add(self, identifier: str, **parameters) -> str:
        action_uuid = new_uuid()
        self.actions.append(
            {
                "WFWorkflowActionIdentifier": identifier,
                "WFWorkflowActionParameters": {"UUID": action_uuid, **parameters},
            }
        )
        return action_uuid

    def repeat_start(self, input_value: dict | None = None) -> tuple[str, str]:
        group_uuid = new_uuid()
        parameters = {
            "GroupingIdentifier": group_uuid,
            "WFControlFlowMode": 0,
        }
        if input_value is not None:
            parameters["WFInput"] = input_value
        action_uuid = self.add(
            "is.workflow.actions.repeat.each",
            **parameters,
        )
        return group_uuid, action_uuid

    def repeat_end(self, group_uuid: str) -> str:
        return self.add(
            "is.workflow.actions.repeat.each",
            GroupingIdentifier=group_uuid,
            WFControlFlowMode=2,
        )


def build_workflow() -> dict:
    workflow = WorkflowBuilder()

    clipboard = workflow.add("is.workflow.actions.getclipboard")
    share_matches = workflow.add(
        "is.workflow.actions.text.match",
        text=text_token_output(clipboard, "Clipboard"),
        WFMatchTextCaseSensitive=False,
        WFMatchTextPattern=r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+",
    )
    first_share_url = workflow.add(
        "is.workflow.actions.getitemfromlist",
        WFInput=action_output(share_matches, "Matches"),
        WFItemSpecifier="First Item",
    )
    share_url = workflow.add(
        "is.workflow.actions.detect.link",
        WFInput=text_token_output(first_share_url, "Item from List"),
    )
    page = workflow.add(
        "is.workflow.actions.downloadurl",
        WFURL=text_token_output(share_url, "URL"),
    )
    page_html = workflow.add(
        "is.workflow.actions.gethtmlfromrichtext",
        WFInput=action_output(page, "URL的内容"),
        WFMakeFullDocument=False,
    )
    image_matches = workflow.add(
        "is.workflow.actions.text.match",
        WFMatchTextPattern=r'content="(http://sns-webpic-qc\.xhscdn\.com[^"]+)"',
        text=text_token_output(page_html, "来自多信息文本的HTML"),
    )
    workflow.add(
        "is.workflow.actions.setvariable",
        WFInput=action_output(image_matches, "匹配"),
        WFVariableName="照片匹配组",
    )

    image_group, _ = workflow.repeat_start(named_variable("照片匹配组"))
    image_url = workflow.add(
        "is.workflow.actions.detect.link",
        WFInput=text_token_repeat_item(),
    )
    workflow.add(
        "is.workflow.actions.downloadurl",
        WFURL=text_token_output(image_url, "URL"),
    )
    image_items = workflow.repeat_end(image_group)
    workflow.actions[-1]["WFWorkflowActionParameters"]["CustomOutputName"] = "所有照片"

    selected_images = workflow.add(
        "is.workflow.actions.choosefromlist",
        WFChooseFromListActionPrompt="选择要保存到照片的图片",
        WFChooseFromListActionSelectAll=True,
        WFChooseFromListActionSelectMultiple=True,
        WFInput=action_output(image_items, "所有照片"),
    )
    workflow.add(
        "is.workflow.actions.savetocameraroll",
        WFInput=action_output(selected_images, "Chosen Items"),
        WFCameraRollSelectedGroup=ask_each_time(),
    )

    return {
        "WFQuickActionSurfaces": [],
        "WFWorkflowActions": workflow.actions,
        "WFWorkflowClientVersion": "4018.0.4",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": 59511,
            "WFWorkflowIconStartColor": 3980825855,
        },
        "WFWorkflowImportQuestions": [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": [],
    }


def main() -> int:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "红薯收藏夹-纯快捷指令.unsigned.shortcut")
    workflow = build_workflow()
    if "--diagnostic-image-url-to-clipboard" in sys.argv[2:]:
        actions = workflow["WFWorkflowActions"]
        image_url_uuid = actions[9]["WFWorkflowActionParameters"]["UUID"]
        set_clipboard = {
            "WFWorkflowActionIdentifier": "is.workflow.actions.setclipboard",
            "WFWorkflowActionParameters": {
                "UUID": new_uuid(),
                "WFInput": action_output(image_url_uuid, "URL"),
            },
        }
        workflow["WFWorkflowActions"] = actions[:10] + [set_clipboard, actions[11]]
        workflow["WFWorkflowOutputContentItemClasses"] = []
    elif "--diagnostic-clipboard-url" in sys.argv[2:]:
        # Stop after converting the first matched clipboard URL to text.
        workflow["WFWorkflowActions"] = workflow["WFWorkflowActions"][:4]
        workflow["WFWorkflowOutputContentItemClasses"] = ["WFStringContentItem"]
    elif "--diagnostic-image-urls" in sys.argv[2:]:
        # Stop immediately after matching urlDefault values. The Shortcuts CLI
        # can then write the real intermediate output for inspection.
        workflow["WFWorkflowActions"] = workflow["WFWorkflowActions"][:7]
        workflow["WFWorkflowOutputContentItemClasses"] = ["WFStringContentItem"]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        plistlib.dump(workflow, handle, fmt=plistlib.FMT_BINARY, sort_keys=False)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
