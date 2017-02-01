var keycode = require('keycode');
var util = require('./util');
var Packets = require('beam-interactive-node/dist/robot/packets');

var nodeUtil = require('util');

var EventEmitter = require('events').EventEmitter;
//var windowHandler = require('./handlers/window/windoze.js');

function ControlsProcessor(config) {
	this.mouseHandler = require('./handlers/mouse/robotjs');
	this.joyStickConsensus = require('./consensus/mouse/' + config.joyStickConsensus);

	this.handler = require('./handlers/' + config.handler);
	this.consensus = require('./consensus/keyboard/' + config.consensus);

	this.config = config;
	EventEmitter.call(this);
	if (this.config.windowTarget) {
		this.constrainWindow(this.config.windowTarget);
	}
}

nodeUtil.inherits(ControlsProcessor, EventEmitter);

ControlsProcessor.prototype.constrainWindow = function (title) {
	var details = windowHandler.getWindowInfo(title);
	if (details) {
		this.mouseHandler.constrainToWindow(details);
	}
};

/**
 * Given a Key name "W" or a keycode 87 transform that key using the
 * remapping table from the config.
 * @param  {Number|String} code
 * @return {String} the keyname of the remapped key
 */
ControlsProcessor.prototype.remapKey = function(code) {
	var stringCode;
	if (typeof code === 'number') {
		stringCode = keycode(code).toUpperCase();
	} else {
		stringCode = code;
	}

	if (remap[stringCode]) {
		return config.remap[stringCode].toLowerCase();
	}
	return code;
};

ControlsProcessor.prototype.clearAllKeys = function() {
	this.setKeys(Object.keys(map), false, config.remap);
};

ControlsProcessor.prototype.process = function (report, controlState) {
	var tactileResult = report.tactile.map((tactile) => this.processTactile(controlState, report.users, tactile))
	.filter((value) => value !== undefined);

	var joystickResult = report.joystick.map((joystick) => this.processJoyStick(controlState, report.users, joystick))
	.filter((value) => value !== undefined);

	if (joystickResult.length > 0 || tactileResult.length > 0) {
		this.emit('changed', report, controlState);
	}
	return {
		tactile: tactileResult,
		joystick: joystickResult,
		state: 'default'
	};
};
ControlsProcessor.prototype.processTactile = function (controlState, users, tactileState) {
	var control = controlState.getTactileById(tactileState.id);
	var decision = this.consensus(tactileState, users, this.config);
	var changed = false;
	decision = this.checkBlocks(tactileState, decision, controlState);
	if (!decision || decision.action === null) {
		return undefined;
	}
	if (control.action !== decision.action) {
		changed = true;
		if (control.isMouseClick()) {
			this.handleClick(control.label.toLowerCase(), decision.action);
		} else {
			this.setKey(control.name, decision.action);
		}
		control.action = decision.action;

		if (control.action) {
			decision.cooldown = control.cooldown;
		} else {
			decision.cooldown = 0;
		}
	}
	if (decision.progress !== control.progress || changed) {
		changed = true;
		control.progress = decision.progress;
	}

	// Here we only send a progress update if something has changed. be it the progress
	if (changed) {
		return this.createProgressForKey(control, decision);
	}
	return undefined;
};

ControlsProcessor.prototype.processJoyStick = function (controlState, users, joyStickState) {
	var control = controlState.getJoyStickById(joyStickState.id);
	var result = this.joyStickConsensus(joyStickState, users, this.config, controlState);
	if (result) {
		this.mouseHandler.moveTo(result.x, result.y);
		joyStickState.progress = result;
		return this.createProgressForJoyStick(control, result);
	}
};

/**
 * Given a tactile state, an in progress decision and a set of 2 paired keys
 * Block the current key from being pushed if its paired key is down.
 * @param  {Object} keyState State to check
 * @param  {Object} decision Decision in progress
 * @param  {String} a        The first key in the pair, the one to block
 * @param  {String} b        The second key in the pair, the one to check for
 * @return {Object}          The updated decision
 */
ControlsProcessor.prototype.checkBlock = function (stateA, stateB, decision) {
	if (stateB && stateB.action) {
		decision.action = false;
		decision.progress = 0;
	}
	return decision;
};

/**
 * Give a tactile state loop through the blocks as defined in the config, 
 * working out if this current decision should be blocked
 * @param  {Object} keyState State to check
 * @param  {Object} decision Current decision in progress
 * @return {Object}
 */
ControlsProcessor.prototype.checkBlocks = function (keyState, decision, state) {
	var self = this;
	Object.keys(self.config.blocks).forEach((blockA) => {
		if (keyState.label.toLowerCase() !== blockA.toLowerCase()) {
			return;
		}
		decision = self.checkBlock(keyState, state.getTactileByLabel(self.config.blocks[blockA]), decision);
	});
	return decision;
};
/**
 * Given a key name set it to the apropriate status
 * @param {String} keyName The key name, "W" and not 87
 * @param {Boolean} status  true to push the key, false to release
 */
ControlsProcessor.prototype.setKey = function (keyName, status) {
	// Beam reports back keycodes, convert them to keynames, which our handlers accept
	if (typeof keyName === 'number') {
		console.log('warning setting by number');
		keyName = keycode(keyName);
	}

	// Something in remapping or handling sometimes makes this undefined
	// It causes an error to proceed so we'll stop here
	if (!keyName) {
		return;
	}

	if (status) {
		this.handler.press(keyName.toUpperCase());
	} else {
		this.handler.release(keyName.toUpperCase());
	}
};

ControlsProcessor.prototype.handleClick = function (button, status) {
	if (button.search('left') !== -1) {
		console.log('left');
		this.mouseHandler.leftClick();
		return;
	}
	if (button.search('right') !== -1) {
		console.log('right');
		this.mouseHandler.rightClick();
		return;
	}
};

/**
 * Given a tactile from a Tetris report, generate a ProgressUpdate packet
 * to be sent back to Tetris
 * @param  {Object} keyObj The tactile from the report
 * @param  {Object} result The decision from the decision maker process
 * @return {Object}        The tactile progress update to be sent back to tetris
 */
ControlsProcessor.prototype.createProgressForKey = function (keyObj, result) {
	return new Packets.ProgressUpdate.TactileUpdate({
		id: keyObj.id,
		cooldown: keyObj.cooldown,
		fired: result.action,
		progress: result.progress
	});
};

ControlsProcessor.prototype.createProgressForJoyStick = function (state, result) {
	if (result) {
		return new Packets.ProgressUpdate.JoystickUpdate({
			id: state.id,
			angle: result.angle,
			intensity: result.intensity
		});
	}
};

ControlsProcessor.prototype.constrainMouse = function (mouseBounds) {
	this.mouseHandler.constrainMouse(mouseBounds);
};

ControlsProcessor.prototype.clearKeys = function (keysToClear) {
	util.convertToArray(keysToClear)
	.forEach((tactile) => {
		if (tactile.action) {
			tactile.clear();
			this.setKey(tactile.name, false);
		}
	});
};

module.exports = ControlsProcessor;
