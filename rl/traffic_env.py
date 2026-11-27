"""
Gymnasium environment for the traffic signal simulator
"""

import gymnasium as gym
from gymnasium import spaces
import numpy as np 

from simulator_client import SimulatorClient

"""
# this happens in two steps :-
SimulatorClient() starts Node and runs the JavaScript bridge, which waits for Python’s commands.
_send("init", ...) tells the bridge to create the traffic simulation with the settings Python sends.
"""

class TrafficEnv(gym.Env):
    """
    Let an agent choose green durations based on detected traffic queues 
    """
    def __init__(self , * , step_seconds : float = 5 , max_episode_steps: int = 120):
        super().__init__()

        # one agent decision advances the simulation by step seconds.
        # the bridge accepts up to 3,600 simulated seconds per request.

        if not 0 < step_seconds <= 3600:
            raise ValueError("step_seconds must be greater than 0 and at most 3600.")
        if max_episode_steps < 1:
            raise ValueError("max_episode_steps must be at least 1 , not sufficient steps")

        # the defaults give 120 decisions per episode , one every 5 seconds 
        # means will be running for 10 minutes 
        self.step_seconds = step_seconds
        self.max_episode_steps = max_episode_steps
        self._steps = 0

        # gymnasium calls reset() to start an episode before agent performs an action and do a step
        # we use the reset() to initialize the env 
        self._needs_reset = True
        self._client = SimulatorClient()

        try :
            # Network mode lets the agent choose durations at all controlled.
            # junctions . Demand 1 means the simulator's normal traffic demand .
            
            star = self._send(
                "init",
                settings = {
                    "seed" : 42,
                    "mode": "network",
                    "demand": 1,
                    "maxRedSeconds": 60,
                },
            )
            # Close 


        
