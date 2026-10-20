"""Deterministic DAG planning for the v2 controller."""

from __future__ import annotations

from dataclasses import dataclass, field

from backend.models.contracts import Asset, InputConfig


@dataclass(frozen=True)
class PlanNode:
    name: str
    tool_name: str
    depends_on: tuple[str, ...] = ()
    params: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ExecutionPlan:
    nodes: tuple[PlanNode, ...]


class DAGPlanner:
    """Create a stable controller graph from the request and acquired assets."""

    def plan(self, query: InputConfig, scenes: list[Asset]) -> ExecutionPlan:
        nodes: list[PlanNode] = [
            PlanNode("acquisition", "acquisition.fetch", params={"months": len(scenes)}),
            PlanNode("validation", "validator.assets", depends_on=("acquisition",)),
            PlanNode("area", "geo.area", depends_on=("validation",), params={"bbox": query.bbox}),
        ]
        previous = "validation"
        for index, scene in enumerate(scenes):
            node_name = f"indices-{index}"
            tool_name = "geo.indices" if scene.mode == "optical" else "sar.backscatter"
            nodes.append(
                PlanNode(
                    node_name,
                    tool_name,
                    depends_on=(previous,),
                    params={"scene_id": scene.scene_id, "mode": scene.mode},
                )
            )
            previous = node_name
        for index in range(1, len(scenes)):
            nodes.append(
                PlanNode(
                    f"change-{index}",
                    "change.detect",
                    depends_on=(f"indices-{index - 1}", f"indices-{index}"),
                    params={"before": scenes[index - 1].scene_id, "after": scenes[index].scene_id},
                )
            )
        nodes.append(PlanNode("integrator", "metrics.integrate", depends_on=(previous, "area")))
        nodes.append(PlanNode("composer", "answer.compose", depends_on=("integrator",)))
        return ExecutionPlan(tuple(nodes))
