import test from "node:test";
import assert from "node:assert/strict";
import {validateGoal,validateGoalStage,goalProgress} from "../utils/goalWorkspace.js";

test("goal payload cannot overwrite owner or include arbitrary fields",()=>{
    assert.equal(validateGoal({name:"Test",owner_id:"not mine"}),null);
    assert.equal(validateGoal({name:"Test",manual_progress:Infinity}),null);
    assert.equal(validateGoal({name:"Test",due_date:"2026-02-30"}),null);
    assert.equal(validateGoal({name:" Test "}).name,"Test");
    assert.equal(validateGoal({name:"One",progress_mode:"metric",metric_start:50,metric_target:50}),null);
    assert.equal(validateGoal({metric_start:3},{name:"Old",metric_start:0,metric_target:100}).metric_start,3);
});
test("four modes, weighted stages and descending metrics",()=>{
    const stages=[{weight:1,completed_at:"2026-11-24"},{weight:3,completed_at:null}];
    assert.equal(goalProgress({progress_mode:"manual",manual_progress:40}),40);
    assert.equal(goalProgress({progress_mode:"milestones"},stages),25);
    assert.equal(goalProgress({progress_mode:"metric",metric_start:90,metric_target:70,metric_current:80}),50);
    assert.equal(goalProgress({progress_mode:"combined",metric_start:0,metric_target:100,metric_current:50,metric_share:0.6},stages),40);
    assert.equal(goalProgress({progress_mode:"metric",metric_start:0,metric_target:100,metric_current:150}),100);
    assert.equal(goalProgress({progress_mode:"milestones"},[]),0);
});
test("stage weight is positive and completion is not accepted at creation",()=>{
    assert.deepEqual(validateGoalStage({title:" Step ",weight:2}),{title:"Step",weight:2});
    assert.equal(validateGoalStage({title:"Step",weight:0}),null);
    assert.equal(validateGoalStage({title:"Step",completed:true}),null);
});

test("explicit milestones set achieved percentages without normalizing by weights",()=>{
    const stages=[{id:1,position:0,weight:1,completion_percent:60,completed_at:"2026-11-24"},{id:2,position:1,weight:1,completion_percent:100,completed_at:null}];
    assert.equal(goalProgress({progress_mode:"milestones"},stages),60);
    assert.equal(goalProgress({progress_mode:"milestones"},[{...stages[0],completed_at:null},{...stages[1],completed_at:"2026-11-24"}]),100);
    assert.equal(goalProgress({progress_mode:"combined",metric_start:0,metric_target:100,metric_current:40,metric_share:0.5},stages),50);
    assert.equal(validateGoalStage({title:"Step",completion_percent:60}).completion_percent,60);
    assert.equal(validateGoalStage({title:"Step",completion_percent:101}),null);
    assert.equal(validateGoal({name:"Timer",progress_mode:"total_timer",metric_target:0}),null);
    assert.equal(validateGoal({name:"Timer",progress_mode:"total_timer",metric_target:600}).metric_target,600);
});
