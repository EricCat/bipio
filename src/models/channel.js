/**
 *
 * The Bipio API Server
 *
 * @author Michael Pearson <github@m.bip.io>
 * Copyright (c) 2010-2013 Michael Pearson https://github.com/mjpearson
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *

 */
/**
 *
 * Channels are configuration instances for pods, they are both a model and a
 * strategy/bridge pattern for interacting with channel pods and their related
 * actions.
 *
 */
var BipModel = require('./prototype.js').BipModel,
helper = require('../lib/helper');

var Channel = Object.create(BipModel);

Channel.entityName = 'channel';
Channel.entitySchema = {
  id: {
    type: String,
    index: true,
    renderable: true,
    writable: false
  },

  owner_id : {
    type: String,
    index: true,
    renderable: false,
    writable: false
  },

  name: {
    type: String,
    renderable: true,
    required : true,
    writable: true,
    "default" : "",
    validate : [
    {
      validator : BipModel.validators.notempty,
      msg : "Cannot be empty"
    },
    {
      validator : BipModel.validators.len_64,
      msg : "64 characters max"
    }
    ]
  },
  app_id : {
    type: String,
    renderable: true,
    writable: true,
    "default" : ""
  },
  action: {
    type: String,
    renderable: true,
    required : true,
    writable: true,
    set : function(action) {
      var podAction = Channel.getPodTokens(action);
      if (podAction.ok()) {
        this.config = pods[podAction.pod].getConfigDefaults(podAction.action);
      }
      return action;
    },
    "default" : "",
    validate : [
    {
      validator : BipModel.validators.notempty,
      msg : "Cannot be empty"
    },

    {
      validator : function(val, next) {
        next( validAction(val) );
      },
      msg : 'Invalid Pod or Action'
    },

    {
      validator : function(val, next) {
        var ok = false;
        if (validAction(this.action)) {
          // validate the config for this action
          ok = true;
        }
        next(ok);
      },
      msg : 'Action Configuration Error'
    }
    ]
  },

  config:  {
    type: Object,
    renderable: true,
    required : true,
    writable: true,
    "default" : {},
    validate : [
    {
      validator : function(val, next) {
        var ok = false;
        if (validAction(this.action)) {
          // validate the config for this action
          ok = true;
        }
        next(ok);
      },
      msg : 'Invalid Config'
    }
    ]
  },

  _available : {
    type: Boolean,
    renderable: true,
    writable: false,
    "default" : true
  },
  note: {
    type: String,
    renderable: true,
    writable: true,
    validate : [
    {
      validator : BipModel.validators.max_text,
      msg : "Text is too long, 1kb max"
    }
    ]
  },
  icon : {
    type: String,
    renderable: true,
    writable: true,
    "default" : ""
  },
  created : {
    type: Number,
    renderable: true,
    writable: false
  }
};

Channel.compoundKeyConstraints = {
  "owner_id" : 1,
  "name" : 1,
  "action" : 1
};

function validAction(value) {
  var ok = false;
  ok = (undefined != value && value != '' && value != 0);
  if (ok) {
    var tTokens = value.split('.');
    var pod = tTokens[0], podAction = tTokens[1];

    ok = (undefined != pods[pod] && undefined != pods[pod].getAction(podAction));
  }
  return ok;
}

// Pod Binder
Channel.staticChildInit = function() {
  var self = this;
  // initialize each channel pod
  for (var idx in pods) {
    pods[idx].init(
      idx,
      this.getDao(),
      app.modules.cdn,
      app.logmessage,
      {
        config : CFG.pods[idx],
        blacklist : CFG.server.public_interfaces,
        baseUrl : self._dao.getBaseUrl(),
        cdnPublicBaseURL : CFG.cdn_public,
        cdnBasePath : 'cdn',
        emitterBaseURL :  (CFG.site_emitter || CFG.website_public) + '/emitter',
        timezone : CFG.timezone,
        isMaster : app.isMaster
      }
    );
  }

  return this;
};

Channel.getActionTokens = function() {
  var tokens, retr = {};
  if (this.action) {
    tokens = this.action.split('.');
  }

  return {
    pod : tokens[0],
    action : tokens[1]
  }
}

/**
 * Transforms adjacentExports into an import usable by this Channel.  Transforms
 * are applied to imports under these conditions
 *
 *  - import < explicit export
 *  - import < template
 *  - import < _bip.{attribute}
 *  - import < _client.{attribute}
 *  - import < {channel_id}.{attribute}
 *  - no transforms, exports = import (do not need to explicitly transform 1:1)
 *
 */

Channel._transform = function(adjacentExports, transforms) {
  var self = this,
    pod = this.getPodTokens();
    resolvedImports = {}; // final imports for the channel

  app._.each(transforms, function(transform, key) {
    var literalMatch = ("" === transform.replace(helper.regActionUUID, '').trim()),
      matches = transform.match(helper.regActionUUID),
      matchMap = {},
      mapKeys;

    app._.each(matches, function(matchStr) {
      var pathResult;

      matchStrNorm = matchStr.replace(/\[%|\s|%\]/g, ''),
      pathExp = matchStrNorm.replace(/#/, '.');

      pathResult = app.helper.jsonPath(adjacentExports, pathExp);

      matchMap[matchStr] = pathResult.length === 1 ? pathResult.shift() : pathResult;
    });

    mapKeys = Object.keys(matchMap);

    // forward object substructure
    if (1 === mapKeys.length && literalMatch) {
      resolvedImports[key] = matchMap[mapKeys[0]];
    } else {
      app._.each(matchMap, function(value, key) {
        var dataStruct = app.helper.isObject(value) || app.helper.isArray(value),
          repl = new RegExp(app.helper.escapeRegExp(key), 'g');

        try {
          transform = transform.replace(repl, dataStruct ? JSON.stringify(value) : value);
        } catch (err) {
          GLOBAL.app.logmessage(err, 'error');
        }
      });
      resolvedImports[key] = transform;
    }
  });

  return helper.naturalize(resolvedImports);
}

/**
 *
 * Applies transforms to imports for this channel and invokes this channel
 *
 */
Channel.invoke = function(adjacentExports, transforms, client, contentParts, next) {
  var self = this;

  var transformedImports = this._transform(adjacentExports, transforms),
    podTokens = this.getActionTokens(),
    podName = podTokens.pod,
    pod = pods[podName];

  // attach bip and client configs
  var sysImports = {
    client : client,
    bip : adjacentExports._bip
  }

  // invoke method
  client.owner_id = this.owner_id;

  pod.bindUserAuth(sysImports, this.owner_id, function(err, sysImports) {
    if (!err) {
      pods[podName].invoke(
        podTokens.action,
        self,
        transformedImports,
        sysImports,
        contentParts,
        next
      );
    } else {
      next(err);
    }
  });
}

/**
 *
 * passes through an RPC call to a
 *
 */
Channel.rpc = function(rpcName, query, client, req, res) {
  var self = this,
    podTokens = this.getActionTokens(),
    pod = pods[podTokens.pod],
    sysImports = {
      client : client
    };

  pod.bindUserAuth(sysImports, this.owner_id, function(err, sysImports) {
    if (err) {
      res.status(500).send(err);
    } else {
      pods[podTokens.pod].rpc(
        podTokens.action,
        rpcName,
        sysImports,
        req.query,
        self,
        req,
        res
      );
    }
  });
}

Channel.pod = function(podName) {
  var ret, tokens, schema;
  if (podName) {
    if (undefined != pods[podName]) {
      ret = pods[podName];
    }
  } else if (this.action && '' !== this.action) {
    tokens = this.action.split('.');
    ret = schema = pods[tokens[0]];

  } else {
    ret = pods;
  }
  return ret;
}

Channel.isRealtime = function() {
  var ret = false, pod;
  if (this.action && '' !== this.action) {
    tokens = this.action.split('.');
    pod = pods[tokens[0]];
    if (pod) {
      ret = pod.isRealtime(tokens[1]);
    }
  }

  return ret;
}

Channel.hasRenderer = function(renderer) {
  var tokens = this.action.split('.'),
  pod = this.pod(tokens[0]);
  return pod.isRenderer(tokens[1], renderer);
}

Channel.getActionList = function() {
  var actions, result = [];

  for (pod in pods) {
    actions = pods[pod].listActions();
    if (actions && actions.length) {
      for (var i = 0; i < actions.length; i++ ) {
        result.push(pod + '.' + actions[i].name);
      }
    }
  }

  return result;
}

Channel.getEmitterList = function() {
  var emitters, result = [];

  for (pod in pods) {
    emitters = pods[pod].listEmitters();
    if (emitters && emitters.length) {
      for (var i = 0; i < emitters.length; i++ ) {
        result.push(pod + '.' + emitters[i].name);
      }
    }
  }

  return result;
}

// post save, run pod initialization
/**
 *
 * @param {Object} sysInfo struct of { 'user' : account info, 'sys' : system generic }
 *
 */
Channel.postSave = function(accountInfo, next, isNew) {
  var tTokens = this.action.split('.'),
  podName = tTokens[0], action = tTokens[1],
  self = this, authType =  pods[podName].getAuthType();

  if (undefined == podName || undefined == action) {
    // throw a constraint crit
    console.log('crit: Channel [' + this.id + '] Init post save but no action?');
    throw DEFS.ERR_CONSTRAINT;
    return;
  }

  this.accountInfo = undefined;
  accountInfo.user.channels.set(this);

  // channels behave a little differently, they can have postponed availability
  // after creation, which the pod actions themselves might want to dictate.

  if (authType && 'none' !== authType) {
    self._dao.getPodAuthTokens(accountInfo.user.id, pods[podName], function(err, authStruct) {
      if (err) {
        next(err, 'channel', { message : err }, 500);
      } else if (!authStruct) {
        next(
          'Channel not authenticate',
          'channel',
          {
            message : 'Channel not authenticated'
          },
          500
        );

        // @todo - set channel availability to false
      } else {
        var auth = {};
        auth[authType] = authStruct;
        pods[podName].setup(action, self, accountInfo, auth, function(err) {
          next(err, 'channel', self);
        });
      }
    });
  } else {
    pods[podName].setup(action, this, accountInfo, function(err) {
      next(err, 'channel', self);
    });
  }

  if (isNew) {
    GLOBAL.app.bastion.createJob(DEFS.JOB_USER_STAT, {
      owner_id : accountInfo.user.id,
      type : 'channels_total'
    } );
  }
}

/**
 * Checks whether any bips are pointed to this channel and if not,
 * calls any pod teardowns.
 */
Channel.preRemove = function(id, accountInfo, next) {
  var tTokens = this.action.split('.'),
  podName = tTokens[0], action = tTokens[1],
  self = this;

  this.getBips(id, accountInfo, function(err, results) {
    // removing channel where it has bips, conflict
    if (!err && results && results.length > 0) {
      next('Channel still has Bips attached', 'channel', {
        message : 'Channel still has Bips attached'
      }, 409);
    } else {
      pods[podName].teardown(action, self, accountInfo, function(err) {
        next(err, 'channel', self);
      });
    }
  });
}

Channel.getActionSchema = function() {
  if (this.action) {
    var tokens = this.action.split('.'),
      podName = tokens[0],
      actionName = tokens[1],
      pod = pods[tokens[0]];
    return pod.getAction(actionName);
  }
  return null;
}

// @todo deprecate
Channel.getPodTokens = function() {
  var ret = {
    ok : function() {
      return (undefined != this.pod);
    }
  };
  if (this.action) {
    var tokens = this.action.split('.');
    if (tokens.length == 2) {
      ret.name = ret.pod = tokens[0];
      ret.action = tokens[1];
      ret._struct = pods[ret.pod];
      ret.getSchema = function(key) {
        var ptr = JSON.parse(JSON.stringify(pods[this.pod].getSchema(this.action)));
        if (key && ptr[key]) {
          return ptr[key];
        }
        return ptr;
      };
      ret.isTrigger = function() {
        return pods[this.pod].isTrigger(this.action);
      },
      // get all unique keys
      ret.getSingletonConstraints = function() {
        var schema = this.getSchema(),
        constraints = {}, singleton = false;

        for (key in schema.config.properties) {
          if (schema.config.properties[key].unique) {
            singleton = true;
            constraints[key] = schema.config.properties;
          }
        }

        return singleton ? constraints : null;
      }
    }
  }
  return ret;
}

Channel.getPod = function() {
  var tokens = this.action.split('.'),
    podName = tokens[0],
    actionName = tokens[1];

  return pods[tokens[0]];
}

Channel.getPods = function(name) {
  if (name && pods[name]) {
    return pods[name];
  } else {
    return pods;
  }
}

// We try to inject defaults into channel configs to avoid patching documents
// in mongo with default configs as they change.
Channel.getConfig = function() {
  var config = {};

  pod = this.getPodTokens();

  var podConfig = pods[pod.name].getActionConfig(pod.action);

  for (key in podConfig.properties) {
    if (!this.config[key] && podConfig.properties[key]['default']) {
      config[key] = podConfig.properties[key]['default'];
    } else if (this.config[key]) {
      config[key] = this.config[key];
    }
  }

  return config;
}

/**
 * Tests a named import is valid for the configured chanenl
 */
Channel.testImport = function(importName) {
  var ok = false,
  pod = this.getPodTokens();

  if (pod.ok()) {
    ok = pods[pod.name].testImport(pod.action, importName);
  }

  return ok;
}

/**
 *
 * Gets configured Bips for this channel
 *
 */
Channel.getBips = function(channelId, accountInfo, next) {
  this._dao.getBipsByChannelId(channelId, accountInfo, next);
}

/**
 * Given a transformSource lookup, retrieves the default transform for this
 * channels configured pod.action
 *
 */
Channel.getTransformDefault = function(transformSource) {
  var transform,
  action = this.getPodTokens();

  if (action.ok()) {
    transform = pods[action.pod].getTransformDefault(transformSource, action.action);
  }

  return transform;
}

Channel.getRendererUrl = function(renderer, accountInfo) {
  var action = this.getPodTokens(),
    rStruct,
    ret,
    cid = this.getIdValue();

  var action = this.getActionSchema();
  if (cid && action && action.rpcs[renderer]) {
    ret = accountInfo.getDefaultDomainStr(true) + '/rpc/channel/' + cid + '/' + renderer;
  }

  return ret;
}


Channel.href = function() {
  return this._dao.getBaseUrl() + '/rest/' + this.entityName + '/' + this.getIdValue();
}

/**
 * Channel representation
 */
Channel.repr = function(accountInfo) {
  var repr = '',
    tokens;

  if (this.action) {
    tokens = this.getActionTokens();
    repr = pods[tokens.pod].repr(tokens.action, this);
  }

  return repr;
}

/**
 * Attaches model links (channel rpcs)
 *
 */
Channel.links = function( accountInfo ) {
  var action = this.getActionSchema(),
    rpc,
    links = [];

  if (accountInfo && action) {
    // add global invokers
    links.push({
      name : 'invoke',
      title : 'Invoke',
      description : 'Invokes the Channel with ad-hoc imports',
      contentType : DEFS.CONTENTTYPE_JSON,
      _href : accountInfo.getDefaultDomainStr(true) + '/rpc/channel/' + this.getIdValue() + '/invoke'
    });

    if (action.rpcs) {
      for (var idx in action.rpcs) {
        if (action.rpcs.hasOwnProperty(idx)) {
          rpc = app._.clone(action.rpcs[idx]);
          rpc.name = idx;
          rpc._href = this.getRendererUrl(idx, accountInfo);
          links.push(rpc);
        }
      }
    }
  }

  return links;
}

Channel.isAvailable = function() {
  return this._available;
}

// register pods
if (!process.HEADLESS) {
  var pods = {};
  for (var podName in CFG.pods) {
    if (CFG.pods.hasOwnProperty(podName) && podName !== 'testing') {
      pods[podName] = require('bip-pod-' + podName);
      GLOBAL.app.logmessage('POD:' + podName + ':UP');
    }
  }
}

module.exports.Channel = Channel;
