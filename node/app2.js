'use strict';
let express = require('express'),
    bodyParser = require('body-parser'),
    app = express(),
    request = require('request');

let messages = require('./supportive-messages');

const MONGODB = require('mongodb');

const config = require('config');

let warning_message_1 = "```Dear participant, please make sure each message sent by you describe one stressful event you faced in the last 24 hours. We kindly invite you to rewrite your last sentence, so we can deliver it to the chatbot.```";

let warning_message_2 = "```Dear participant, please make sure you send only text messages (containing more than 10 words). We kindly invite you to rewrite your last sentence, so we can deliver it to the chatbot.```";

let welcome_message = "```Hello, there! You have just started to participate in our experiment! Here goes your PARTICIPANT ID: P_ID```"

const INTERACTION_MODE = (process.env.INTERACTION_MODE) ?
  process.env.INTERACTION_MODE :
  config.get('INTERACTION_MODE');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

const MONGODB_URI = (process.env.MONGODB_URI) ?
  (process.env.MONGODB_URI) :
  config.get('MONGODB_URI');

const MONGODB_DB = (process.env.MONGODB_DB) ?
  (process.env.MONGODB_DB) :
  config.get('MONGODB_DB');

const MONGODB_COL_MESSAGES = (process.env.MONGODB_COL_MESSAGES) ?
  (process.env.MONGODB_COL_MESSAGES) :
  config.get('MONGODB_COL_MESSAGES');

const MONGODB_COL_USERS = (process.env.MONGODB_COL_USERS) ?
  (process.env.MONGODB_COL_USERS) :
  config.get('MONGODB_COL_USERS');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

const IBM_WATSON_ASSIST_USERNAME = (process.env.IBM_WATSON_ASSIST_USERNAME) ?
  (process.env.IBM_WATSON_ASSIST_USERNAME) :
  config.get('IBM_WATSON_ASSIST_USERNAME');

const IBM_WATSON_ASSIST_PASSWORD = (process.env.IBM_WATSON_ASSIST_PASSWORD) ?
  (process.env.IBM_WATSON_ASSIST_PASSWORD) :
  config.get('IBM_WATSON_ASSIST_PASSWORD');

const IBM_WATSON_ASSIST_WORKSPACE_ID = (process.env.IBM_WATSON_ASSIST_WORKSPACE_ID) ?
  (process.env.IBM_WATSON_ASSIST_WORKSPACE_ID) :
  config.get('IBM_WATSON_ASSIST_WORKSPACE_ID');

const IBM_WATSON_NLU_USERNAME = (process.env.IBM_WATSON_NLU_USERNAME) ?
  (process.env.IBM_WATSON_NLU_USERNAME) :
  config.get('IBM_WATSON_NLU_USERNAME');

const IBM_WATSON_NLU_PASSWORD = (process.env.IBM_WATSON_NLU_PASSWORD) ?
  (process.env.IBM_WATSON_NLU_PASSWORD) :
  config.get('IBM_WATSON_NLU_PASSWORD');

if (INTERACTION_MODE != "bot") {
  warning_message_1 = warning_message_1.replace('chatbot', 'other participant');
  warning_message_2 = warning_message_2.replace('chatbot', 'other participant');
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

let users = {};

const PORT = process.env.PORT || 1337;

app.listen(PORT, () => console.log('Daily stress assist app listening on port ' + PORT + '!'));

app.get('/', (req, res) => res.send('Daily stress assist up and running! ;)'));

app.post('/webhook', (req, res) => {
  console.log("app.post('/webhook', (req, res) => {");
  let body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(function(entry) {
      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender.id;
      if (webhook_event.message) {
        let received_message = webhook_event.message;
        if (!received_message.text || received_message.text.split(" ").length <= 10) {
          callSendAPI(sender_psid, warning_message_2);
        } else {
          analyzeSentiment(received_message.text).then(
            res => {
              if (res != "negative") {
                callSendAPI(sender_psid, warning_message_1);
              } else {
                checkIfTheUserIsNew(sender_psid).then(
                  res => {
                    if (res) {
                      let wmessage = welcome_message.replace("P_ID", sender_psid);
                      callSendAPI(sender_psid, wmessage);
                    }
                    if (INTERACTION_MODE != "bot") {
                      setTimeout(function(){
                        callTypingOn(sender_psid)
                      }, 5000);
                      setTimeout(function(){
                        handleMessage(sender_psid, webhook_event.message)
                      }, 10000);
                    } else {
                      handleMessage(sender_psid, webhook_event.message);
                    }
                  }
                )
              }
            }
          )
        }
      } else if (webhook_event.postback) {
        handlePostback(sender_psid, webhook_event.postback);
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VALIDATION_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

function handleMessage(sender_psid, received_message) {
  getResponseFromWatson(received_message.text, sender_psid).then(
    res => {
      getResponseFromTemplates(sender_psid, res).then(
        res => {
          callSendAPI(sender_psid, res);
        });
    });
}

function saveMessageFromUser(messageFromUser, classificationByWatson, sender_psid) {
  let uri = MONGODB_URI;
  MONGODB.MongoClient.connect(uri, {useNewUrlParser: true}, function(err, client) {
    if(err) throw err;
    let db = client.db(MONGODB_DB);
    let messages = db.collection(MONGODB_COL_MESSAGES);
    var datetime = new Date();
    let newMessage = {
      sender: sender_psid,
      datetime: datetime,
      message: messageFromUser,
      classification: classificationByWatson
    }
    messages.insertOne(newMessage, function(err, result) {
      if (err) throw err;
    });
    client.close(function (err) {
      if(err) throw err;
    });
  });
}

function checkIfTheUserIsNew(sender_psid) {
  return new Promise(function(resolve, reject) {
    let uri = MONGODB_URI;
    MONGODB.MongoClient.connect(uri, {useNewUrlParser: true}, function(err, client) {
      if(err) throw err;
      let db = client.db(MONGODB_DB);
      let users = db.collection(MONGODB_COL_USERS);
      users.findOne({ user_id: sender_psid }, function(err, result) {
        if (err) throw err;
        if (result == null) {
          resolve(true);
        } else {
          resolve(false);
        }
        client.close(function (err) {
          if(err) throw err;
        });
      });
    });
  })
}

function getResponseFromTemplates(sender_psid, strategy) {
  return new Promise(function(resolve, reject) {
    let messageToReturn = "";
    let uri = MONGODB_URI;
    MONGODB.MongoClient.connect(uri, {useNewUrlParser: true}, function(err, client) {
      if(err) throw err;
      let db = client.db(MONGODB_DB);
      let users = db.collection(MONGODB_COL_USERS);
      users.findOne({ user_id: sender_psid }, function(err, result) {
        if (err) throw err;
        if (result == null) {
          let newUser = {
            user_id: sender_psid,
            user_GES: 0,
            user_GES_GRIEF: 0,
            user_AD: 0,
            user_CC: 0,
            user_SM: 0
          }
          resolve(STRATEGIES[strategy.toLowerCase()][0]);
          newUser["user_"+strategy] = 1;
          users.insertOne(newUser, function(err, result) {
            if (err) throw err;
          });
        } else {
          resolve(STRATEGIES[strategy.toLowerCase()][result["user_"+strategy]]);
          let newValue = 0;
          let fieldToUpdate = "user_"+strategy;
          if (result["user_"+strategy] != STRATEGIES[strategy.toLowerCase()].length - 1) {
            newValue = result["user_"+strategy] + 1;
          }
          users.updateOne(
            { user_id: result["user_id"] },
            { $set: { [fieldToUpdate]:  newValue } },
            function (err, result) {
              if (err) throw err;
            }
          );
        }
        client.close(function (err) {
          if(err) throw err;
        });
      });
    });
  })
}

function callTypingOn(sender_psid, cb = null) {
  let request_body = {
      "recipient": {
          "id": sender_psid
      },
      "sender_action":"typing_on"
  };
  request({
      "uri": "https://graph.facebook.com/v3.1/me/messages",
      "qs": { "access_token": PAGE_ACCESS_TOKEN },
      "method": "POST",
      "json": request_body
  }, (err, res, body) => {
      if (!err) {
          if(cb){
              cb();
          }
      } else {
          console.error("Unable to do the request: " + err);
      }
  });
}

function callSendAPI(sender_psid, response, cb = null) {
  let request_body = {
      "messaging_type": "RESPONSE",
      "recipient": {
          "id": sender_psid
      },
      "message": {
        "text": response
      }
  };
  request({
      "uri": "https://graph.facebook.com/v3.1/me/messages",
      "qs": { "access_token": PAGE_ACCESS_TOKEN },
      "method": "POST",
      "json": request_body
  }, (err, res, body) => {
      if (!err) {
          if(cb){
              cb();
          }
      } else {
          console.error("Unable to send message: " + err);
      }
  });
}

var NaturalLanguageUnderstandingV1 = require('watson-developer-cloud/natural-language-understanding/v1.js');
var nlu = new NaturalLanguageUnderstandingV1({
  username: IBM_WATSON_NLU_USERNAME,
  password: IBM_WATSON_NLU_PASSWORD,
  version: '2018-04-05',
  url: 'https://gateway.watsonplatform.net/natural-language-understanding/api/'
});

function analyzeSentiment(messageToAnalyze) {
  var options = {
    text: messageToAnalyze,
    features: {
      sentiment: {}
    }
  };
  return new Promise(function(resolve, reject) {
    nlu.analyze(options, function(err, res) {
      if (err) {
        console.log(err);
        reject(err);
      }
      resolve(res['sentiment']['document']['label']);
    });
  })
}

var AssistantV1 = require('watson-developer-cloud/assistant/v1');
var assistant = new AssistantV1({
  username: IBM_WATSON_ASSIST_USERNAME,
  password: IBM_WATSON_ASSIST_PASSWORD,
  url: 'https://gateway.watsonplatform.net/assistant/api/',
  version: '2018-09-19'
});

function getResponseFromWatson(inputFromUser, sender_psid) {
  return new Promise(function(resolve, reject) {
    assistant.message(
      {
        input: {text: inputFromUser},
        workspace_id:  IBM_WATSON_ASSIST_WORKSPACE_ID
      },
      function(err, response) {
        if (err) {
          reject(err);
        } else {
          saveMessageFromUser(inputFromUser, response["entities"], sender_psid);
          resolve(response["output"]["generic"][0]["text"]);
        }
      }
    )
  })
}
