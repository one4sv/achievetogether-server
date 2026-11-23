import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGoalInput, normalizeMilestone, goalProgress } from "../utils/goalProgress.js";

test("goal payload rejects ownership injection and malformed numbers", () => {
    assert.equal(normalizeGoalInput({ name:"My goal", owner_id:"other" }), null);
    assert.equal(normalizeGoalInput({ name:"My goal", metric_target:Infinity }), null);
    assert.equal(normalizeGoalInput({ name:"My goal", progress_mode:"metric", metric_target:0 }), null);
    assert.equal(normalizeGoalInput({ name:"My goal", due_date:"2026-02-30" }), null);
    assert.equal(normalizeGoalInput({ name:"  Read 20 books  ", progress_mode:"manual" }).name,"Read 20 books");
    assert.equal(normalizeGoalInput({ progress_mode:"metric" }, { name:"Existing", metric_start:0, metric_target:10 })?.progress_mode,"metric");
});

test("goal progress supports manual, increasing and decreasing metrics", () => {
    assert.equal(goalProgress({ progress_mode:"manual", manual_progress:30 }),30);
    assert.equal(goalProgress({ progress_mode:"metric", metric_start:0, metric_target:100, metric_current:35 }),35);
    assert.equal(goalProgress({ progress_mode:"metric", metric_start:95, metric_target:75, metric_current:85 }),50);
    assert.equal(goalProgress({ progress_mode:"metric", metric_start:0, metric_target:10, metric_current:20 }),100);
});

test("milestones use configurable weights without duplicate plan/activity credit", () => {
    const milestones = [{weight:1,completed_at:"2026-11-23"}, {weight:3,completed_at:null}];
    assert.equal(goalProgress({ progress_mode:"milestones" },milestones),25);
    assert.equal(goalProgress({ progress_mode:"combined", metric_start:0, metric_target:100,
        metric_current:50, metric_share:0.7 },milestones),42.5);
    assert.equal(goalProgress({ progress_mode:"milestones" },[]),0);
    assert.equal(normalizeMilestone({title:" Finish stage ",weight:2})?.title,"Finish stage");
    assert.equal(normalizeMilestone({title:"Stage",weight:0}),null);
});
