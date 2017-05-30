'use strict';

/**
 * django channels engine
 * @author avigmati@gmail.com
 */

function ServerException(error, action_obj) {
    this.error = 'DCEngine server error: '+error;
    this.action_obj = action_obj;
}


function ClientException(error) {
    this.error = 'DCEngine client error: '+error;
}


function RequestException(error, error_data) {
    this.error = 'DCEngine request error: '+error;
    this.error_data = error_data;
}


let initialized = false;

const debug = (typeof DCE_DEBUG !== 'undefined') ? DCE_DEBUG : false;

let socket_url;
if (typeof DCE_SOCKET_URL === 'undefined') {
    throw new ClientException('DCE_SOCKET_URL undefined.')
} else {
    socket_url = DCE_SOCKET_URL;
}

let registered_consumers = [];


class Core {
    constructor(url, debug) {
        this.debug = debug;
        this.socket = new WebSocket(url);
        this.socketQueueId = 0;
        this.socketQueue = {};

        this.consumer_handler = null;
        this.init_handler = null;

        this.socket.onmessage = (event) => {
            let response = {};
            try {
                response = JSON.parse(event.data);
            } catch(e) {
                throw new ClientException('response json parse error: ' + e);
            }

            /*
             * rpc responses
             * */
            if (typeof(response['cmd_id']) !== 'undefined' && typeof(this.socketQueue['i_'+response['cmd_id']]) === 'function') {
                let execFunc = this.socketQueue['i_'+response['cmd_id']];
                execFunc(response);
                delete this.socketQueue['i_'+response['cmd_id']];
            }
            /*
             * non rpc responses
             * */
            else {
                switch (response.msg_type === 'service') {
                    /*
                     * service messages
                     * */
                    case true:
                        if (response.status === 'error') {
                            throw new ServerException(response.error, response.error_data);
                        } else {
                            this.init_handler(response.data.actions, response.data.version);
                        }
                        break;
                    /*
                     * user messages
                     * */
                    case false:
                        this.consumer_handler(response);
                        break;
                }
            }
        };
        this.socket.onopen = (event) => {
            if (this.debug) {
                console.log('Socket open.');
            }
        };
        this.socket.onclose = () => {
            if (this.debug) {
                console.log('Socket close.');
            }
        }
    }

    send_rpc(message, callback) {
        this.waitForConnection(() => {

            if (typeof callback !== 'undefined') {
                this.socketQueueId++;
                this.socketQueue['i_'+this.socketQueueId] = callback;
                message.cmd_id = this.socketQueueId;
                this.socket.send(JSON.stringify(message));
            }

        }, 1000);
    };

    send_consumer(message) {
        this.waitForConnection(() => {

            if (Array.isArray(message.data.callbacks)) {
                message.callbacks = message.data.callbacks;
            } else {
                message.callbacks = [];
            }
            this.socket.send(JSON.stringify(message));

        }, 1000);
    };

    waitForConnection(send_func, interval) {
        if (this.socket.readyState === 1) {
            send_func();
        } else {
            let that = this;
            setTimeout(function () {
                that.waitForConnection(send_func, interval);
            }, interval);
        }
    };

    call(action_name, action_type, data) {
        let that = this;

        if (action_type === 'rpc') {
            return new Promise((resolve, reject) => {
                that.send_rpc({'action': action_name, 'data': data}, (response) => {
                    if (response.status !== 'error') {
                        resolve(response.data)
                    } else {
                        reject({error: response.error, data: response.error_data})
                    }
                });
            });
        } else {
            return new Promise((resolve, reject) => {
                resolve(that.send_consumer({'action': action_name, 'data': data}));
            });
        }
    }

    set_consumer_handler(handler) {
        this.consumer_handler = handler;
    }
    set_init_handler(handler) {
        this.init_handler = handler;
    }
}


class DCEngine {
    constructor(socket_url, debug) {
        this.debug = debug;

        this.init = this.init.bind(this);
        this.call = this.call.bind(this);
        this.base_consumer = this.base_consumer.bind(this);

        this.core = new Core(socket_url, debug);
        this.core.set_consumer_handler(this.base_consumer);
        this.core.set_init_handler(this.init);
    }

    static create_action_proto(base, names, value) {
        /*
         Creates nested prototype path for action function
         */
        let lastName = arguments.length === 3 ? names.pop() : false;
        for(let i in names) {
            base = base[ names[i] ] = base[ names[i] ] || {};
        }
        if( lastName ) base = base[ lastName ] = value;
        return base;
    };

    static get_action(obj, path) {
        /*
         Return action func by provided path
         */
        let found = obj;
        if (typeof found === "function") {
            return found
        } else {
            for (let part of path) {
                if (obj.hasOwnProperty(part)) {
                    if (path.length) {
                        path.splice(path.indexOf(part), 1);
                        return DCEngine.get_action(obj[part], path)
                    }
                }
            }
        }
    }

    init(actions, version){
        /*
         Initialize actions
         */
        const log_actions = actions.map(method => {
            // create action func
            let that = this;
            let f = function(...args) {return that.call(method.name, ...args)};
            f.prototype['_dce_name'] = method.name;
            f.prototype['_dce_type'] = method.type;

            // create action func prototype
            DCEngine.create_action_proto(DCEngine.prototype, method.name.split('.'), f);

            // return log entry
            return '['+method.type.toUpperCase()+'] '+method.name
        });
        initialized = true;
        if (this.debug) {
            console.log('DCEngine v'+version+' initialized with actions: ', log_actions);
        }
    }

    call(action, ...args){
        /*
         Call wrapper on core.call function, prepares data, parameters for call
         */

        // prepare data
        let data = {};
        for (let x of args) {
            if ((x === Object(x)) && !(typeof x === 'function')) {
                data = x;
            }
        }

        // get action func
        const f = DCEngine.get_action(this.__proto__, action.split('.'));

        // call action
        return this.core.call(f.prototype['_dce_name'], f.prototype['_dce_type'], data);
    };

    base_consumer(message){
        /*
         Routes income messages to consumers
         */
        switch (Array.isArray(message.consumers) && message.consumers.length > 0) {
            case true:
                for (let c of message.consumers) {
                    // let consumer = this.get_consumer(c);
                    let consumer = get_consumer(c);
                    if (typeof consumer !== 'undefined') {
                        consumer(message.data, message.error, message.error_data)
                    }
                }
                break;
            case false:
                if (message.status === 'error') {
                    throw new RequestException(message.error, message.error_data);
                } else {
                    console.log('DCEngine.base_consumer:', message);
                }
        }
    }
}

function get_consumer(consumer_name) {
    /*
     Returns consumer class method by consumer class name
     */
    for (let c of registered_consumers) {
        if (c.name === consumer_name) {
            return c.consumer;
        }
    }
}

export function consumer(target) {
    /*
     Decorator for consumer class
     */
    registered_consumers.push({
        'name': target.prototype.constructor.name,
        'consumer': target.prototype.consumer
    });
}

function call_action(obj, path, path_str, data){
    /*
     Run action func by provided path
     */
    let func = obj;
    if (typeof func === "function") {
        return func(data)
    } else {
        for (let part of path) {
            if (obj.hasOwnProperty(part)) {
                if (path.length) {
                    path.splice(path.indexOf(part), 1);
                    return call_action(obj[part], path, path_str, data)
                }
            }
        }
    }
    return new Promise((resolve, reject) => {
        reject(path_str + ' not implemented.');
    });
}

function executeWaitForCriteria(f, criteria, interval) {
    if (criteria()) {
        f();
    } else {
        setTimeout(function () {
            executeWaitForCriteria(f, criteria, interval);
        }, interval);
    }
}


const dcengine = new DCEngine(socket_url, debug);


export function dce(action, data) {
    return new Promise((resolve, reject) => {
        executeWaitForCriteria(() => {
                call_action(dcengine.__proto__, action.split('.'), action, data).then(function(result) {
                    resolve(result);
                }, function(error) {
                    reject(error);
                });
            },
            () => {
                return initialized
            },
            500);
    });
}

