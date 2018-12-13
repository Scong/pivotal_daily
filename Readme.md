Run chron job via 

```node -e 'require("./index").init()'```

To just get text of report run

```node -e 'require("./index").generate()'```

A specific date may tentatively be passed to either function, maybe have side effects.

Daily story notes may be added to pivotal tracker stories via adding "<=>" to text of story, only the last updated comment with the spaceship operator will be reported in the daily. 
